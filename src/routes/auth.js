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
  REMEMBER_RENEW_AFTER_SECONDS,
  REMEMBER_TTL_SECONDS,
  clearOpaqueCookie,
  createPendingStore,
  createSession,
  hashToken,
  isMobileUserAgent,
  readCookie,
  replaceDeviceSessions,
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
const TOTP_SETUP_TTL_MS = 10 * 60_000;
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
      if (!token) {
        if (request.softAuth) return next();
        return response.status(401).json({ error: 'برای ادامه وارد شوید.' });
      }
      const [rows] = await pool.execute(
        `SELECT u.id, u.username, u.full_name, u.role, u.region_id, u.is_active,
                u.must_change_password, s.token_hash, s.remember,
                (s.expires_at < DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND)) AS renew_due
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP() AND u.is_active = 1`,
        [REMEMBER_TTL_SECONDS - REMEMBER_RENEW_AFTER_SECONDS, hashToken(token)],
      );
      if (!rows.length) {
        clearOpaqueCookie(response, 'session', config.nodeEnv);
        if (request.softAuth) return next();
        return response.status(401).json({ error: 'نشست معتبر نیست؛ دوباره وارد شوید.' });
      }
      request.user = rows[0];
      request.sessionToken = token;
      request.authTime = clock();
      // نشست «به یاد سپاری»: حداکثر روزی یک‌بار تمدید می‌شود تا تا وقتی کوکی هست (و استفاده می‌شود) هرگز منقضی نشود.
      if (rows[0].remember && Number(rows[0].renew_due)) {
        const now = clock();
        await pool.execute(
          'UPDATE sessions SET expires_at = ? WHERE token_hash = ?',
          [new Date(now + REMEMBER_TTL_SECONDS * 1000), hashToken(token)],
        );
        setOpaqueCookie(response, 'session', token, config.nodeEnv, now, { remember: true });
      }
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
  // رازِ در حال ثبتِ برنامهٔ رمزساز (از صفحهٔ تنظیمات کاربر) تا تأیید با کد، فقط در حافظه نگه داشته می‌شود.
  const totpSetups = new Map();
  function takeSetup(userId, now = clock()) {
    for (const [key, value] of totpSetups) if (value.expiresAt <= now) totpSetups.delete(key);
    return totpSetups.get(Number(userId)) ?? null;
  }
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

  // `remember` فقط برای موبایل است؛ نسخهٔ دسکتاپ همیشه نشست ۲۴ ساعته می‌گیرد، حتی اگر کلاینت «remember» بفرستد.
  async function finishLogin(request, response, user, { remember = false, extra = {} } = {}) {
    const now = clock();
    const persistent = Boolean(remember) && isMobileUserAgent(request.get?.('user-agent'));
    await resetFailures(request, user.username);
    await replaceDeviceSessions(pool, user.id, request, readCookie(request, 'session', config.nodeEnv));
    const session = await createSession(pool, user.id, request, now, { remember: persistent });
    setOpaqueCookie(response, 'session', session.token, config.nodeEnv, now, { remember: persistent });
    const pendingToken = readCookie(request, 'pending', config.nodeEnv);
    pendingStore.delete(pendingToken);
    clearOpaqueCookie(response, 'pending', config.nodeEnv);
    await pool.execute('UPDATE users SET last_login_at = UTC_TIMESTAMP() WHERE id = ?', [user.id]);
    await audit(pool, user.id, 'auth.login', 'user', user.id, request);
    return response.json({ ok: true, must_change_password: Boolean(user.must_change_password), remembered: persistent, ...extra });
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

  // کد شش‌رقمی برنامهٔ رمزساز یا یکی از کدهای بازیابی. `user` باید totp_secret_enc و totp_last_step داشته باشد.
  async function verifySecondFactor(user, rawCode) {
    const code = typeof rawCode === 'string' ? rawCode.trim().slice(0, 64) : '';
    if (/^\d{6}$/.test(code)) {
      if (!user.totp_secret_enc) return false;
      const secret = base32Decode(decryptTotpSecret(user.totp_secret_enc, config.appSecret));
      const step = verifyTotp(code, secret, { time: clock(), lastStep: Number(user.totp_last_step ?? -1) });
      if (step === null) return false;
      const [result] = await pool.execute(
        `UPDATE users SET totp_last_step = ?
         WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)`,
        [step, user.id, step],
      );
      return result.affectedRows === 1;
    }
    if (!code) return false;
    const [backupRows] = await pool.execute(
      'SELECT id, code_hash FROM backup_codes WHERE user_id = ? AND used_at IS NULL',
      [user.id],
    );
    const hashValues = backupRows.map((row) => Buffer.from(row.code_hash).toString('hex'));
    if (!consumeBackupCode(code, hashValues)) return false;
    const matchingHash = Buffer.from(hashBackupCode(code), 'hex');
    const [result] = await pool.execute(
      'UPDATE backup_codes SET used_at = UTC_TIMESTAMP() WHERE user_id = ? AND code_hash = ? AND used_at IS NULL',
      [user.id, matchingHash],
    );
    return result.affectedRows === 1;
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

      // رمز دومرحله‌ای تنظیم هر کاربر است (صفحهٔ حساب کاربری)؛ اگر روشن نباشد، گذرواژه کافی است.
      const remember = request.body?.remember === true && isMobileUserAgent(request.get?.('user-agent'));
      if (!user.totp_enabled) return finishLogin(request, response, user, { remember });

      const pendingToken = pendingStore.issue(user.id, clock(), { remember });
      setOpaqueCookie(response, 'pending', pendingToken, config.nodeEnv, clock());
      return response.json({ next: 'totp' });
    } catch (error) {
      return next(error);
    }
  });

  // --- رمز دومرحله‌ای به‌عنوان تنظیم کاربر (نیاز به نشست فعال) ---
  router.post('/totp/setup', authenticate, requirePasswordChanged, async (request, response, next) => {
    try {
      const [rows] = await pool.execute('SELECT totp_enabled FROM users WHERE id = ?', [request.user.id]);
      if (rows[0]?.totp_enabled) {
        return response.status(409).json({ error: 'رمز دومرحله‌ای از قبل روشن است.' });
      }
      const secret = base32Encode(randomBytes(20)).replace(/=+$/, '');
      totpSetups.set(Number(request.user.id), { secret, expiresAt: clock() + TOTP_SETUP_TTL_MS });
      const label = encodeURIComponent(`PnuNews:${request.user.username}`);
      const uri = `otpauth://totp/${label}?secret=${secret}&issuer=PnuNews&algorithm=SHA1&digits=6&period=30`;
      const qrSvg = await QRCode.toString(uri, { type: 'svg', errorCorrectionLevel: 'M' });
      return response.json({ secret, qr_svg: qrSvg });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/totp/enable', authenticate, requirePasswordChanged, async (request, response, next) => {
    try {
      const setup = takeSetup(request.user.id);
      if (!setup) {
        return response.status(400).json({ error: 'ابتدا راه‌اندازی برنامهٔ رمزساز را انجام دهید.' });
      }
      const code = typeof request.body?.code === 'string' ? request.body.code.trim() : '';
      if (await lockedOut(request, request.user.username)) {
        return response.status(429).json({ error: 'امکان این کار موقتاً وجود ندارد. کمی بعد دوباره تلاش کنید.' });
      }
      const step = verifyTotp(code, base32Decode(setup.secret), { time: clock(), lastStep: -1 });
      if (step === null) {
        await countFailure(request, request.user.username);
        await audit(pool, request.user.id, 'auth.totp_failed', 'user', request.user.id, request);
        return response.status(401).json({ error: 'کد واردشده معتبر نیست.' });
      }

      const { codes, hashes } = generateBackupCodes();
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [result] = await connection.execute(
          `UPDATE users SET totp_secret_enc = ?, totp_enabled = 1, totp_last_step = ?
           WHERE id = ? AND totp_enabled = 0 AND is_active = 1`,
          [encryptTotpSecret(setup.secret, config.appSecret), step, request.user.id],
        );
        if (result.affectedRows !== 1) throw new Error('Two-factor setup state changed unexpectedly');
        await connection.execute('DELETE FROM backup_codes WHERE user_id = ?', [request.user.id]);
        for (const hash of hashes) {
          await connection.execute('INSERT INTO backup_codes (user_id, code_hash) VALUES (?, ?)', [request.user.id, Buffer.from(hash, 'hex')]);
        }
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
      totpSetups.delete(Number(request.user.id));
      await audit(pool, request.user.id, 'auth.totp_enabled', 'user', request.user.id, request);
      return response.json({ ok: true, totp_enabled: true, backup_codes: codes });
    } catch (error) {
      return next(error);
    }
  });

  // خاموش‌کردن: هم گذرواژه و هم یک کد دومرحله‌ای (یا کد بازیابی) لازم است تا نشستِ دزدیده‌شده نتواند آن را خاموش کند.
  router.post('/totp/disable', authenticate, requirePasswordChanged, async (request, response, next) => {
    try {
      if (await lockedOut(request, request.user.username)) {
        return response.status(429).json({ error: 'امکان این کار موقتاً وجود ندارد. کمی بعد دوباره تلاش کنید.' });
      }
      const [rows] = await pool.execute(
        'SELECT id, password_hash, totp_enabled, totp_secret_enc, totp_last_step FROM users WHERE id = ?',
        [request.user.id],
      );
      const user = rows[0];
      if (!user?.totp_enabled) return response.status(409).json({ error: 'رمز دومرحله‌ای روشن نیست.' });
      const password = typeof request.body?.password === 'string' ? request.body.password.slice(0, MAX_PASSWORD_LENGTH + 1) : '';
      const passwordOk = await verifyPassword(password, user.password_hash);
      const codeOk = passwordOk && await verifySecondFactor(user, request.body?.code);
      if (!passwordOk || !codeOk) {
        await countFailure(request, request.user.username);
        await audit(pool, request.user.id, 'auth.totp_failed', 'user', request.user.id, request);
        return response.status(401).json({ error: 'گذرواژه یا کد واردشده معتبر نیست.' });
      }
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        await connection.execute(
          'UPDATE users SET totp_secret_enc = NULL, totp_enabled = 0, totp_last_step = NULL WHERE id = ?',
          [request.user.id],
        );
        await connection.execute('DELETE FROM backup_codes WHERE user_id = ?', [request.user.id]);
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
      await resetFailures(request, request.user.username);
      await audit(pool, request.user.id, 'auth.totp_disabled', 'user', request.user.id, request);
      return response.json({ ok: true, totp_enabled: false });
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
      if (await lockedOut(request, context.user.username)) {
        return response.status(429).json({ error: 'امکان ورود موقتاً وجود ندارد. کمی بعد دوباره تلاش کنید.' });
      }

      const valid = await verifySecondFactor(context.user, request.body?.code);

      if (!valid) {
        await countFailure(request, context.user.username);
        countPendingFailure(context);
        await audit(pool, context.user.id, 'auth.totp_failed', 'user', context.user.id, request);
        return response.status(401).json({ error: 'کد واردشده معتبر نیست.' });
      }
      await audit(pool, context.user.id, 'auth.totp_success', 'user', context.user.id, request);
      return finishLogin(request, response, context.user, { remember: Boolean(context.pending.remember) });
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

  // Soft "who is looking?" check for the public reader (inline editing): never a 401 for a visitor without a session,
  // and nothing but the bare minimum about a signed-in staff member. A user who must still change the password is
  // treated as signed out here, exactly as the admin API refuses them.
  router.get('/viewer', (request, response, next) => {
    request.softAuth = true; // no session: authenticate lets the request through without a user instead of answering 401
    return authenticate(request, response, async (error) => {
      if (error) return next(error);
      const user = request.user;
      if (!user || user.must_change_password) return response.json({ user: null });
      return response.json({ user: { id: user.id, full_name: user.full_name, role: user.role } });
    });
  });

  router.get('/me', authenticate, async (request, response, next) => {
    try {
      // `level` is the type of the user's unit (country / province / city); `domain_*` is set for domain users only.
      const [rows] = await pool.execute(
        `SELECT r.type AS level, u.domain_id, d.name AS domain_name, u.totp_enabled
         FROM users u JOIN regions r ON r.id = u.region_id
         LEFT JOIN work_domains d ON d.id = u.domain_id WHERE u.id = ?`,
        [request.user.id],
      );
      return response.json({
        user: {
          id: request.user.id,
          username: request.user.username,
          full_name: request.user.full_name,
          role: request.user.role,
          region_id: request.user.region_id,
          level: rows[0]?.level ?? null,
          domain_id: rows[0]?.domain_id ?? null,
          domain_name: rows[0]?.domain_name ?? null,
          must_change_password: Boolean(request.user.must_change_password),
          totp_enabled: Boolean(rows[0]?.totp_enabled),
          // آیا نشست فعلی «به یاد سپاری» است، و آیا این دستگاه اجازهٔ آن را دارد (فقط موبایل).
          session_remembered: Boolean(request.user.remember),
          can_remember: isMobileUserAgent(request.get?.('user-agent')),
        },
      });
    } catch (error) {
      return next(error);
    }
  });

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
      return response.json({ ok: true, reauthentication_required: true });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/sessions', authenticate, requirePasswordChanged, async (request, response, next) => {
    try {
      const [rows] = await pool.execute(
        `SELECT token_hash, user_agent, ip, created_at, expires_at, remember
         FROM sessions WHERE user_id = ? AND expires_at > UTC_TIMESTAMP()
         ORDER BY created_at DESC`,
        [request.user.id],
      );
      const current = hashToken(request.sessionToken);
      const sessions = rows.map((row) => ({
        user_agent: row.user_agent,
        ip: row.ip,
        created_at: row.created_at,
        expires_at: row.expires_at,
        remember: Boolean(row.remember),
        current: Buffer.from(row.token_hash).equals(current),
      }));
      return response.json({ sessions });
    } catch (error) {
      return next(error);
    }
  });

  router.delete('/sessions', authenticate, async (request, response, next) => {
    try {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        await connection.execute('DELETE FROM sessions WHERE user_id = ?', [request.user.id]);
        await connection.execute(
          `INSERT INTO audit_log (user_id, action, entity, entity_id, ip)
           VALUES (?, 'auth.sessions_revoked', 'user', ?, ?)`,
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
