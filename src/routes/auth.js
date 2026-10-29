import { createHmac, randomBytes } from 'node:crypto';
import express from 'express';
import QRCode from 'qrcode';
import {
  base32Decode,
  base32Encode,
  consumeBackupCode,
  decryptTotpSecret,
  encryptTotpSecret,
  generateBackupCodes,
  generateTotp,
  hashBackupCode,
  hashPassword,
  verifyPassword,
  verifyTotp,
} from '../auth/crypto.js';
import {
  clearOpaqueCookie,

  createPendingStore,
  createSession,
  createTrustedDevice,
  hashToken,
  readCookie,

  setOpaqueCookie,
} from '../auth/sessions.js';

import { createRateLimiter } from '../lib/ratelimit.js';

// Per (client address, username): stops one client guessing.
const FAILURE_THRESHOLD = 5;
// Per username across all addresses: stops a distributed guess. Higher, so that it is hard to use for locking someone out.
const GLOBAL_FAILURE_THRESHOLD = 30;
const FAILURE_LOCK_SECONDS = 15 * 60;
const MAX_USERNAME_LENGTH = 80;
const MAX_PASSWORD_LENGTH = 1024;
const MAX_PENDING_CODE_FAILURES = 5;
const DUMMY_PASSWORD_HASH = `scrypt$16384$8$1$${'00'.repeat(16)}$${'00'.repeat(64)}`;
const ANY_ADDRESS = '*';

function audit(pool, userId, action, entity, entityId, request, meta = null) {
  return pool.execute(
    `INSERT INTO audit_log (user_id, action, entity, entity_id, meta, ip)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId ?? null, action, entity, entityId ?? null, meta ? JSON.stringify(meta) : null, request.ip ?? null],
  );
}

function validPassword(password, username) {
  return typeof password === 'string' && password.length >= 10 && password.length <= MAX_PASSWORD_LENGTH &&
    password.toLocaleLowerCase() !== username.toLocaleLowerCase();
}

async function isLocked(pool, ipHash, usernameHash, anyAddressHash) {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS locked FROM login_attempts
     WHERE username_hash = ? AND ip_hash IN (?, ?) AND locked_until IS NOT NULL AND locked_until > UTC_TIMESTAMP()`,
    [usernameHash, ipHash, anyAddressHash],
  );
  return Number(rows[0]?.locked) > 0;
}

async function recordFailure(pool, ipHash, usernameHash, threshold = FAILURE_THRESHOLD) {
  await pool.execute(
    `INSERT INTO login_attempts (ip_hash, username_hash, failed_count, locked_until, updated_at)
     VALUES (?, ?, 1, NULL, UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE
       failed_count = IF(locked_until IS NOT NULL AND locked_until <= UTC_TIMESTAMP(), 1, failed_count + 1),
       locked_until = IF(failed_count >= ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ${FAILURE_LOCK_SECONDS} SECOND), NULL),
       updated_at = UTC_TIMESTAMP()`,
    [ipHash, usernameHash, threshold],
  );
}

async function clearFailures(pool, ipHash, usernameHash, anyAddressHash) {
  await pool.execute(
    'DELETE FROM login_attempts WHERE username_hash = ? AND ip_hash IN (?, ?)',
    [usernameHash, ipHash, anyAddressHash],
  );
}

export function createAuthMiddleware(pool, config, clock = Date.now) {
  return async function authenticate(request, response, next) {
    try {
      const token = readCookie(request, 'session', config.nodeEnv);
      if (!token) return response.status(401).json({ error: 'برای ادامه وارد شوید.' });
      const [rows] = await pool.execute(
        `SELECT u.id, u.username, u.full_name, u.role, u.region_id, u.is_active,
                u.must_change_password, s.token_hash
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP() AND u.is_active = 1`,
        [hashToken(token)],
      );
      if (!rows.length) {
        clearOpaqueCookie(response, 'session', config.nodeEnv);
        return response.status(401).json({ error: 'نشست معتبر نیست؛ دوباره وارد شوید.' });
      }
      request.user = rows[0];
      request.sessionToken = token;
      request.authTime = clock();
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

export function requirePasswordChanged(request, response, next) {
  if (request.user.must_change_password) {
    return response.status(403).json({ error: 'پیش از ادامه، گذرواژهٔ خود را تغییر دهید.', code: 'password_change_required' });
  }
  return next();
}

export function createAuthRouter({ pool, config, clock = Date.now }) {
  const router = express.Router();
  const pendingStore = createPendingStore(clock);
  const authenticate = createAuthMiddleware(pool, config, clock);
  // Password hashing is expensive, so the credential endpoints get their own per-address budget on top of the lockout.
  const credentialRateLimit = createRateLimiter({ limit: 30, windowMs: 60_000, clock });
  router.use(['/login', '/totp', '/change-password'], (request, response, next) => (
    request.method === 'POST' ? credentialRateLimit(request, response, next) : next()
  ));

  // Keyed with APP_SECRET so the stored values cannot be reversed by hashing the IPv4 space.
  const hashIdentity = (value) => createHmac('sha256', config.appSecret).update(String(value)).digest();
  const anyAddressHash = hashIdentity(ANY_ADDRESS);
  // `username` must be the canonical stored name when the account exists: the database compares
  // names case-insensitively, so keying by what was typed would let "Admin"/"aDmin" dodge the lockout.
  function attemptKeys(request, username) {
    return {
      ipHash: hashIdentity(request.ip ?? 'unknown'),
      usernameHash: hashIdentity(String(username).normalize('NFKC').toLocaleLowerCase()),
    };
  }
  async function lockedOut(request, username) {
    const { ipHash, usernameHash } = attemptKeys(request, username);
    return isLocked(pool, ipHash, usernameHash, anyAddressHash);
  }
  async function countFailure(request, username) {
    const { ipHash, usernameHash } = attemptKeys(request, username);
    await recordFailure(pool, ipHash, usernameHash);
    await recordFailure(pool, anyAddressHash, usernameHash, GLOBAL_FAILURE_THRESHOLD);
  }
  // Counters are only reset once the *whole* login (password and second factor) has succeeded;
  // resetting after the password step alone would give unlimited second-factor guesses.
  async function resetFailures(request, username) {
    const { ipHash, usernameHash } = attemptKeys(request, username);
    await clearFailures(pool, ipHash, usernameHash, anyAddressHash);
  }
  // A pending (password-verified) login may only try a few codes before it has to start over.
  function countPendingFailure(context) {
    context.pending.failures = (context.pending.failures ?? 0) + 1;
    if (context.pending.failures >= MAX_PENDING_CODE_FAILURES) pendingStore.delete(context.token);
  }

  async function finishLogin(request, response, user, { rememberDevice = false, extra = {} } = {}) {
    const now = clock();
    await resetFailures(request, user.username);
    const session = await createSession(pool, user.id, request, now);
    setOpaqueCookie(response, 'session', session.token, config.nodeEnv, now);
    const pendingToken = readCookie(request, 'pending', config.nodeEnv);
    pendingStore.delete(pendingToken);
    clearOpaqueCookie(response, 'pending', config.nodeEnv);
    if (rememberDevice) {
      const device = await createTrustedDevice(pool, user.id, request, now);
      setOpaqueCookie(response, 'device', device.token, config.nodeEnv, now);
    }
    await pool.execute('UPDATE users SET last_login_at = UTC_TIMESTAMP() WHERE id = ?', [user.id]);
    await audit(pool, user.id, 'auth.login', 'user', user.id, request);
    return response.json({ ok: true, must_change_password: Boolean(user.must_change_password), ...extra });
  }

  async function pendingUser(request) {
    const token = readCookie(request, 'pending', config.nodeEnv);
    const pending = pendingStore.get(token, clock());
    if (!pending) return null;
    const [rows] = await pool.execute(
      `SELECT id, username, full_name, role, region_id, is_active, must_change_password,
              totp_enabled, totp_secret_enc, totp_last_step
       FROM users WHERE id = ?`,
      [pending.userId],
    );
    if (!rows.length || !rows[0].is_active) return null;
    return { token, pending, user: rows[0] };
  }

  router.post('/login', async (request, response, next) => {
    try {
      const username = typeof request.body?.username === 'string' ? request.body.username.trim() : '';
      const password = typeof request.body?.password === 'string' ? request.body.password : '';
      if (username.length > MAX_USERNAME_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
        return response.status(401).json({ error: 'نام کاربری یا گذرواژه نادرست است.' });
      }
      const [rows] = await pool.execute(
        `SELECT id, username, full_name, role, region_id, password_hash, is_active,
                must_change_password, totp_enabled
         FROM users WHERE username = ? LIMIT 1`,
        [username],
      );
      const user = rows[0];
      const lockName = user?.username ?? username;
      if (await lockedOut(request, lockName)) {
        return response.status(429).json({ error: 'امکان ورود موقتاً وجود ندارد. کمی بعد دوباره تلاش کنید.' });
      }
      const passwordOk = await verifyPassword(password, user?.password_hash ?? DUMMY_PASSWORD_HASH);
      if (!user || !user.is_active || !passwordOk) {
        await countFailure(request, lockName);
        await audit(pool, user?.id, 'auth.login_failed', 'user', user?.id, request);
        return response.status(401).json({ error: 'نام کاربری یا گذرواژه نادرست است.' });
      }

      if (user.totp_enabled) {
        const deviceToken = readCookie(request, 'device', config.nodeEnv);
        if (deviceToken) {
          const [deviceRows] = await pool.execute(
            `SELECT id FROM trusted_devices
             WHERE token_hash = ? AND user_id = ? AND expires_at > UTC_TIMESTAMP() LIMIT 1`,
            [hashToken(deviceToken), user.id],
          );
          if (deviceRows.length) {
            await pool.execute('UPDATE trusted_devices SET last_used_at = UTC_TIMESTAMP() WHERE id = ?', [deviceRows[0].id]);
            return finishLogin(request, response, user);
          }
        }
      }

      const pendingToken = pendingStore.issue(user.id, clock());
      setOpaqueCookie(response, 'pending', pendingToken, config.nodeEnv, clock());
      return response.json({ next: user.totp_enabled ? 'totp' : 'totp_setup' });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/totp/setup', async (request, response, next) => {
    try {
      const context = await pendingUser(request);
      if (!context || context.user.totp_enabled) {
        return response.status(401).json({ error: 'مرحلهٔ ثبت کد دومعتبره منقضی شده است؛ دوباره وارد شوید.' });
      }
      const secret = base32Encode(randomBytes(20)).replace(/=+$/, '');
      context.pending.totpSecret = secret;
      const label = encodeURIComponent(`PnuNews:${context.user.username}`);
      const uri = `otpauth://totp/${label}?secret=${secret}&issuer=PnuNews&algorithm=SHA1&digits=6&period=30`;
      const qrSvg = await QRCode.toString(uri, { type: 'svg', errorCorrectionLevel: 'M' });
      return response.json({ secret, qr_svg: qrSvg });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/totp/enable', async (request, response, next) => {
    try {
      const context = await pendingUser(request);
      if (!context || context.user.totp_enabled || !context.pending.totpSecret) {
        return response.status(401).json({ error: 'ابتدا راه‌اندازی برنامهٔ رمزساز را انجام دهید.' });
      }
      const code = typeof request.body?.code === 'string' ? request.body.code : '';
      if (await lockedOut(request, context.user.username)) {
        return response.status(429).json({ error: 'امکان ورود موقتاً وجود ندارد. کمی بعد دوباره تلاش کنید.' });
      }
      const secretBytes = base32Decode(context.pending.totpSecret);
      const step = verifyTotp(code, secretBytes, { time: clock(), lastStep: -1 });
      if (step === null) {
        await countFailure(request, context.user.username);
        countPendingFailure(context);
        await audit(pool, context.user.id, 'auth.totp_failed', 'user', context.user.id, request);
        return response.status(401).json({ error: 'کد واردشده معتبر نیست.' });
      }

      const { codes, hashes } = generateBackupCodes();
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [result] = await connection.execute(
          `UPDATE users SET totp_secret_enc = ?, totp_enabled = 1, totp_last_step = ?
           WHERE id = ? AND totp_enabled = 0 AND is_active = 1`,
          [encryptTotpSecret(context.pending.totpSecret, config.appSecret), step, context.user.id],
        );
        if (result.affectedRows !== 1) throw new Error('Two-factor setup state changed unexpectedly');
        for (const hash of hashes) {
          await connection.execute('INSERT INTO backup_codes (user_id, code_hash) VALUES (?, ?)', [context.user.id, Buffer.from(hash, 'hex')]);
        }
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
      await audit(pool, context.user.id, 'auth.totp_enabled', 'user', context.user.id, request);
      return finishLogin(request, response, context.user, { extra: { backup_codes: codes } });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/totp', async (request, response, next) => {
    try {
      const context = await pendingUser(request);
      if (!context || !context.user.totp_enabled || !context.user.totp_secret_enc) {
        return response.status(401).json({ error: 'مرحلهٔ تأیید دومعتبره منقضی شده است؛ دوباره وارد شوید.' });
      }
      const code = typeof request.body?.code === 'string' ? request.body.code.trim().slice(0, 64) : '';
      if (await lockedOut(request, context.user.username)) {
        return response.status(429).json({ error: 'امکان ورود موقتاً وجود ندارد. کمی بعد دوباره تلاش کنید.' });
      }

      let valid = false;
      const isTotp = /^\d{6}$/.test(code);
      if (isTotp) {
        const secret = base32Decode(decryptTotpSecret(context.user.totp_secret_enc, config.appSecret));
        const step = verifyTotp(code, secret, { time: clock(), lastStep: Number(context.user.totp_last_step ?? -1) });
        if (step !== null) {
          const [result] = await pool.execute(
            `UPDATE users SET totp_last_step = ?
             WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)`,
            [step, context.user.id, step],
          );
          valid = result.affectedRows === 1;
        }
      } else if (code) {
        const [backupRows] = await pool.execute(
          'SELECT id, code_hash FROM backup_codes WHERE user_id = ? AND used_at IS NULL',
          [context.user.id],
        );
        const hashValues = backupRows.map((row) => Buffer.from(row.code_hash).toString('hex'));
        if (consumeBackupCode(code, hashValues)) {
          const matchingHash = Buffer.from(hashBackupCode(code), 'hex');
          const [result] = await pool.execute(
            'UPDATE backup_codes SET used_at = UTC_TIMESTAMP() WHERE user_id = ? AND code_hash = ? AND used_at IS NULL',
            [context.user.id, matchingHash],
          );
          valid = result.affectedRows === 1;
        }
      }

      if (!valid) {
        await countFailure(request, context.user.username);
        countPendingFailure(context);
        await audit(pool, context.user.id, 'auth.totp_failed', 'user', context.user.id, request);
        return response.status(401).json({ error: 'کد واردشده معتبر نیست.' });
      }
      const rememberDevice = request.body?.remember === undefined || request.body.remember === true;
      if (rememberDevice) {
        const device = await createTrustedDevice(pool, context.user.id, request, clock());
        setOpaqueCookie(response, 'device', device.token, config.nodeEnv, clock());
      }
      await audit(pool, context.user.id, 'auth.totp_success', 'user', context.user.id, request);
      return finishLogin(request, response, context.user);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/logout', async (request, response, next) => {
    try {
      const token = readCookie(request, 'session', config.nodeEnv);
      if (token) {
        const [rows] = await pool.execute('SELECT user_id FROM sessions WHERE token_hash = ?', [hashToken(token)]);
        await pool.execute('DELETE FROM sessions WHERE token_hash = ?', [hashToken(token)]);
        if (rows[0]) await audit(pool, rows[0].user_id, 'auth.logout', 'user', rows[0].user_id, request);
      }
      const pendingToken = readCookie(request, 'pending', config.nodeEnv);
      pendingStore.delete(pendingToken);
      clearOpaqueCookie(response, 'session', config.nodeEnv);
      clearOpaqueCookie(response, 'pending', config.nodeEnv);
      return response.json({ ok: true });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/me', authenticate, (request, response) => response.json({
    user: {
      id: request.user.id,
      username: request.user.username,
      full_name: request.user.full_name,
      role: request.user.role,
      region_id: request.user.region_id,
      must_change_password: Boolean(request.user.must_change_password),
    },
  }));

  router.post('/change-password', authenticate, async (request, response, next) => {
    try {
      const oldPassword = typeof request.body?.old_password === 'string' ? request.body.old_password.slice(0, MAX_PASSWORD_LENGTH + 1) : '';
      const newPassword = typeof request.body?.new_password === 'string' ? request.body.new_password : '';
      const [rows] = await pool.execute('SELECT password_hash FROM users WHERE id = ?', [request.user.id]);
      if (!await verifyPassword(oldPassword, rows[0]?.password_hash ?? DUMMY_PASSWORD_HASH)) {
        return response.status(400).json({ error: 'گذرواژهٔ فعلی نادرست است.' });
      }
      if (newPassword === oldPassword) {
        return response.status(400).json({ error: 'گذرواژهٔ تازه نباید با گذرواژهٔ فعلی یکسان باشد.' });
      }
      if (!validPassword(newPassword, request.user.username)) {
        return response.status(400).json({ error: 'گذرواژهٔ تازه باید دست‌کم ۱۰ نویسه باشد و با نام کاربری یکسان نباشد.' });
      }
      const passwordHash = await hashPassword(newPassword);
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        await connection.execute(
          `UPDATE users SET password_hash = ?, must_change_password = 0,
           password_changed_at = UTC_TIMESTAMP() WHERE id = ?`,
          [passwordHash, request.user.id],
        );
        await connection.execute('DELETE FROM sessions WHERE user_id = ?', [request.user.id]);
        await connection.execute('DELETE FROM trusted_devices WHERE user_id = ?', [request.user.id]);
        await connection.execute(
          `INSERT INTO audit_log (user_id, action, entity, entity_id, ip)
           VALUES (?, 'auth.password_changed', 'user', ?, ?)`,
          [request.user.id, request.user.id, request.ip ?? null],
        );
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
      clearOpaqueCookie(response, 'session', config.nodeEnv);
      clearOpaqueCookie(response, 'device', config.nodeEnv);
      return response.json({ ok: true, reauthentication_required: true });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/devices', authenticate, requirePasswordChanged, async (request, response, next) => {
    try {
      const [devices] = await pool.execute(
        `SELECT id, user_agent, ip, created_at, last_used_at, expires_at
         FROM trusted_devices WHERE user_id = ? AND expires_at > UTC_TIMESTAMP()
         ORDER BY last_used_at DESC, id DESC`,
        [request.user.id],
      );
      return response.json({ devices });
    } catch (error) {
      return next(error);
    }
  });

  router.delete('/devices', authenticate, async (request, response, next) => {
    try {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        await connection.execute('DELETE FROM sessions WHERE user_id = ?', [request.user.id]);
        await connection.execute('DELETE FROM trusted_devices WHERE user_id = ?', [request.user.id]);
        await connection.execute(
          `INSERT INTO audit_log (user_id, action, entity, entity_id, ip)
           VALUES (?, 'auth.devices_revoked', 'user', ?, ?)`,
          [request.user.id, request.user.id, request.ip ?? null],
        );
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
      clearOpaqueCookie(response, 'session', config.nodeEnv);
      clearOpaqueCookie(response, 'device', config.nodeEnv);
      return response.json({ ok: true });
    } catch (error) {
      return next(error);
    }
  });

  router.use((error, request, response, next) => {
    console.error(`Auth request failed: ${error.message}`);
    if (response.headersSent) return next(error);
    return response.status(500).json({ error: 'خطای داخلی رخ داد.' });
  });

  return router;
}
