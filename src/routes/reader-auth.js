import express from 'express';
import { createRateLimiter } from '../lib/ratelimit.js';
import { createBookmarkRouter } from './reader-bookmarks.js';
import {
  INBOUND_CONFIRM_GRACE_MS, INBOUND_LOG_KEEP_MS, INBOUND_MAX_OPEN_PER_PHONE, INBOUND_TTL_MS, generateHandle, hashHandle, hashInboundCode, inboundBody,
  isHandle, lineInternational, normalizeLine,
} from '../lib/reader-inbound.js';
import {
  OTP_MAX_ATTEMPTS, OTP_RESEND_GAP_MS, OTP_TTL_MS, cleanOtpInput, cleanPersonName, cleanStudentNumber, generateOtp, hashOtp,
  maskPhone, normalizePhone, readSignupToken, sameHex, signSignupToken,
} from '../lib/reader-auth.js';
import { loadReaderSettings } from '../lib/reader-settings.js';
import { clearReaderCookie, createReaderSession, hashReaderToken, publicReader, readReaderToken, readerAuth, setReaderCookie } from '../lib/reader-session.js';

const HOUR_MS = 60 * 60_000;
const PHONE_REQUESTS_PER_HOUR = 5;
// Per address, not per person: a campus or a mobile carrier puts many readers behind one address, so this is generous. The
// per-number limit and the daily cap are what protect the SMS budget.
const IP_REQUESTS_PER_HOUR = 30;
// The inbound-SMS method costs no SMS, so its limits only keep the table and the abuse small. The status question is asked every
// couple of seconds by every waiting reader, so it has a generous limit of its own (a campus shares one address).
const INBOUND_REQUESTS_PER_PHONE_PER_HOUR = 10;
const INBOUND_REQUESTS_PER_IP_PER_HOUR = 60;
const INBOUND_STATUS_PER_IP_PER_MINUTE = 600;

const MESSAGE = Object.freeze({
  disabled: 'ورود و ثبت‌نام خوانندگان فعلاً غیرفعال است.',
  badPhone: 'شمارهٔ موبایل معتبر نیست؛ مثلاً ۰۹۱۲۱۲۳۴۵۶۷.',
  smsDown: 'ارسال پیامک اکنون ممکن نیست؛ کمی بعد دوباره تلاش کنید.',
  sendFailed: 'ارسال پیامک ناموفق بود؛ کمی بعد دوباره تلاش کنید.',
  busy: 'ظرفیت ارسال پیامک فعلاً پر است؛ کمی بعد دوباره تلاش کنید.',
  phoneLimit: 'برای این شماره بیش از حد کد خواسته شده است؛ یک ساعت دیگر دوباره تلاش کنید.',
  ipLimit: 'از این اتصال بیش از حد کد خواسته شده است؛ یک ساعت دیگر دوباره تلاش کنید.',
  badCode: 'کد باید ۶ رقم باشد.',
  wrongCode: 'کد واردشده درست نیست.',
  expired: 'کد منقضی شده یا بیش از حد تلاش شده است؛ کد تازه بگیرید.',
  tokenExpired: 'مهلت ثبت‌نام تمام شد؛ دوباره با شمارهٔ موبایل شروع کنید.',
  phoneTaken: 'این شماره قبلاً ثبت شده است؛ با همان وارد شوید.',
  studentTaken: 'این شمارهٔ دانشجویی قبلاً برای حساب دیگری ثبت شده است.',
  signIn: 'ابتدا وارد شوید.',
  firstName: 'نام را فقط با حروف و حداکثر ۶۰ نویسه وارد کنید.',
  lastName: 'نام خانوادگی را فقط با حروف و حداکثر ۶۰ نویسه وارد کنید.',
  student: 'مقدار «دانشجو هستم» باید بله یا خیر باشد.',
  studentNo: 'شمارهٔ دانشجویی را فقط با رقم و بین ۶ تا ۱۴ رقم وارد کنید.',
  unit: 'مرکز دانشگاهی را انتخاب کنید.',
  phoneFixed: 'شمارهٔ موبایل پس از ثبت‌نام قابل تغییر نیست.',
  staffProfile: 'اطلاعات حساب مدیریتی از داشبورد مدیریت تغییر می‌کند.',
  methodReceive: 'روش ورود تغییر کرده است؛ صفحه را تازه کنید و دوباره وارد شوید.',
  methodSend: 'این روش ورود فعال نیست؛ صفحه را تازه کنید و دوباره وارد شوید.',
  inboundDown: 'ورود با ارسال پیامک اکنون ممکن نیست؛ کمی بعد دوباره تلاش کنید.',
  openLimit: 'چند درخواست ورود باز دارید؛ چند دقیقه صبر کنید یا درخواست قبلی را کامل کنید.',
  badHandle: 'درخواست معتبر نیست؛ دوباره از شمارهٔ موبایل شروع کنید.',
});

const fail = (response, status, key, extra = {}) => response.status(status).json({ error: MESSAGE[key], code: key, ...extra });

// The fields of the signup form, checked the same way for the first signup and for a later edit of the profile.
// `current` (an edit) supplies the fields the request does not carry.
function parseProfile(body, current = null) {
  const has = (key) => Object.hasOwn(body, key);
  const merged = {
    first_name: has('first_name') ? body.first_name : current?.first_name,
    last_name: has('last_name') ? body.last_name : current?.last_name,
    is_student: has('is_student') ? body.is_student : (current?.is_student ?? false),
    student_no: has('student_no') ? body.student_no : (current?.student_no ?? null),
    unit_id: has('unit_id') ? body.unit_id : (current?.unit_id ?? null),
  };
  const firstName = cleanPersonName(merged.first_name);
  if (!firstName) return { error: 'firstName' };
  const lastName = cleanPersonName(merged.last_name);
  if (!lastName) return { error: 'lastName' };
  if (typeof merged.is_student !== 'boolean') return { error: 'student' };
  let studentNo = null;
  if (merged.is_student) {
    studentNo = cleanStudentNumber(merged.student_no);
    if (!studentNo) return { error: 'studentNo' };
  }
  const unitId = Number(merged.unit_id);
  if (!Number.isSafeInteger(unitId) || unitId <= 0) return { error: 'unit' };
  return { values: { first_name: firstName, last_name: lastName, is_student: merged.is_student, student_no: studentNo, unit_id: unitId } };
}

function duplicateKey(error) {
  if (error?.code !== 'ER_DUP_ENTRY') return null;
  return String(error.message).includes('student_no') ? 'studentTaken' : 'phoneTaken';
}

export function createReaderRouter({ pool, config, clock = Date.now, ippanel, smsBudget }) {
  const router = express.Router();
  const authLimit = createRateLimiter({ limit: 60, windowMs: 60_000, clock });
  const authenticate = readerAuth({ pool, config, clock });
  // Behind a reverse proxy without TRUST_PROXY=1 every reader seems to come from the proxy's address, and the per-address limits
  // would block everyone after a few codes. Say so once, in the log.
  let proxyWarned = false;
  router.use((request, response, next) => {
    if (!proxyWarned && request.headers['x-forwarded-for'] && !request.app.get('trust proxy')) {
      proxyWarned = true;
      console.warn('Reader accounts: requests carry X-Forwarded-For but TRUST_PROXY is not 1, so all readers share one address for the per-address SMS limit. Set TRUST_PROXY=1 behind a reverse proxy.');
    }
    next();
  });
  // The waiting browser asks every couple of seconds whether its SMS has arrived. It has its own, higher limit and is registered
  // before the general /auth limit so it is not counted against it.
  const statusLimit = createRateLimiter({ limit: INBOUND_STATUS_PER_IP_PER_MINUTE, windowMs: 60_000, clock });
  router.post('/auth/inbound-status', statusLimit, async (request, response, next) => {
    try {
      const settings = await loadReaderSettings(pool);
      if (!settings.signup_enabled) return fail(response, 403, 'disabled');
      if (settings.auth_method !== 'sms_receive') return fail(response, 403, 'methodSend');
      const handle = request.body?.handle;
      if (!isHandle(handle)) return fail(response, 400, 'badHandle');
      const now = clock();
      const [rows] = await pool.execute(
        'SELECT id, phone, expires_at, confirmed_at, consumed_at FROM reader_inbound_challenges WHERE handle_hash = ? LIMIT 1',
        [hashHandle(handle)],
      );
      const row = rows[0];
      // Unknown, used and invalidated all look the same: the browser has to start again.
      if (!row || row.consumed_at) return response.json({ ok: true, status: 'expired' });
      if (!row.confirmed_at) {
        const left = new Date(row.expires_at).getTime() - now;
        return response.json(left > 0 ? { ok: true, status: 'waiting', expires_in: Math.ceil(left / 1000) } : { ok: true, status: 'expired' });
      }
      // Confirmed by the webhook. Taking it is atomic: of two parallel questions only one changes the row, the other is told «expired».
      const [taken] = await pool.execute(
        'UPDATE reader_inbound_challenges SET consumed_at = ? WHERE id = ? AND handle_hash = ? AND confirmed_at IS NOT NULL AND consumed_at IS NULL AND confirmed_at > ?',
        [new Date(now), row.id, hashHandle(handle), new Date(now - INBOUND_CONFIRM_GRACE_MS)],
      );
      if (taken.affectedRows !== 1) return response.json({ ok: true, status: 'expired' });
      await pool.execute('DELETE FROM reader_inbound_challenges WHERE phone = ? AND id <> ?', [row.phone, row.id]);
      return response.json(await proofAccepted(request, response, row.phone, now, { status: 'confirmed' }));
    } catch (error) {
      return next(error);
    }
  });

  router.use('/auth', authLimit);
  router.use('/bookmarks', createBookmarkRouter({ pool, clock, authenticate }));

  async function unitExists(unitId) {
    const [rows] = await pool.execute("SELECT id FROM regions WHERE id = ? AND type = 'city' AND visibility_override <> 'hide' LIMIT 1", [unitId]);
    return rows.length > 0;
  }

  async function startSession(request, response, userRow) {
    const now = clock();
    const token = await createReaderSession(pool, userRow.id, now);
    setReaderCookie(response, config.nodeEnv, token, now);
    return publicReader(userRow);
  }

  // 1. A code is sent to the phone number. The answer is the same for a number with an account and one without.
  router.post('/auth/request-code', async (request, response, next) => {
    try {
      const settings = await loadReaderSettings(pool);
      if (!settings.signup_enabled) return fail(response, 403, 'disabled');
      if (settings.auth_method !== 'sms_send') return fail(response, 403, 'methodReceive');
      const phone = normalizePhone(request.body?.phone);
      if (!phone) return fail(response, 400, 'badPhone');
      if (!ippanel.configured) return fail(response, 503, 'smsDown');

      const now = clock();
      const hourAgo = new Date(now - HOUR_MS);
      const [lastRows] = await pool.execute('SELECT created_at FROM reader_otps WHERE phone = ? ORDER BY id DESC LIMIT 1', [phone]);
      if (lastRows[0]) {
        const wait = OTP_RESEND_GAP_MS - (now - new Date(lastRows[0].created_at).getTime());
        if (wait > 0) {
          const seconds = Math.ceil(wait / 1000);
          response.setHeader('Retry-After', String(seconds));
          return response.status(429).json({ error: `برای دریافت کد تازه ${seconds} ثانیه صبر کنید.`, code: 'tooSoon', retry_after: seconds });
        }
      }
      const [[phoneCount]] = await pool.execute('SELECT COUNT(*) AS n FROM reader_otps WHERE phone = ? AND created_at > ?', [phone, hourAgo]);
      if (Number(phoneCount.n) >= PHONE_REQUESTS_PER_HOUR) return fail(response, 429, 'phoneLimit', { retry_after: 3600 });
      const [[ipCount]] = await pool.execute('SELECT COUNT(*) AS n FROM reader_otps WHERE ip = ? AND created_at > ?', [request.ip ?? null, hourAgo]);
      if (Number(ipCount.n) >= IP_REQUESTS_PER_HOUR) return fail(response, 429, 'ipLimit', { retry_after: 3600 });

      const gate = await smsBudget.checkBeforeSend();
      if (!gate.allowed) return gate.reason === 'low_credit' ? fail(response, 403, 'disabled') : fail(response, 503, 'busy');

      const code = generateOtp();
      const [inserted] = await pool.execute(
        'INSERT INTO reader_otps (phone, code_hash, expires_at, ip, created_at) VALUES (?, ?, ?, ?, ?)',
        [phone, hashOtp(config.appSecret, phone, code), new Date(now + OTP_TTL_MS), request.ip ?? null, new Date(now)],
      );
      // One attempt, never repeated: after a timeout the SMS may still arrive (and be charged).
      const outcome = await ippanel.sendPattern(phone, code);
      await pool.execute(
        'INSERT INTO sms_log (masked_phone, ip, ok, message_code, outbox_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [maskPhone(phone), request.ip ?? null, outcome.ok ? 1 : 0, outcome.ok ? null : (outcome.messageCode ?? outcome.kind ?? null), outcome.ok ? outcome.outboxId : null, new Date(clock())],
      );
      await smsBudget.afterSend(outcome, { costRial: settings.sms_cost_rial });
      if (!outcome.ok) {
        await pool.execute('UPDATE reader_otps SET expires_at = ? WHERE id = ?', [new Date(now), inserted.insertId]); // the code never went out: it must not verify
        return fail(response, 502, 'sendFailed');
      }
      // Housekeeping with every sent code: old codes and the SMS log go (the log is only needed for the last day and a few failures).
      await pool.execute('DELETE FROM reader_otps WHERE expires_at < ?', [new Date(now - 24 * HOUR_MS)]);
      await pool.execute('DELETE FROM sms_log WHERE created_at < ?', [new Date(now - 90 * 24 * HOUR_MS)]);
      return response.json({ ok: true, resend_after: OTP_RESEND_GAP_MS / 1000, expires_in: OTP_TTL_MS / 1000 });
    } catch (error) {
      return next(error);
    }
  });

  // 1b. The other method: the reader will send an SMS from their own number to our line. Nothing is sent by us, so no SMS budget is involved.
  router.post('/auth/request-inbound', async (request, response, next) => {
    try {
      const settings = await loadReaderSettings(pool);
      if (!settings.signup_enabled) return fail(response, 403, 'disabled');
      if (settings.auth_method !== 'sms_receive') return fail(response, 403, 'methodSend');
      const phone = normalizePhone(request.body?.phone);
      if (!phone) return fail(response, 400, 'badPhone');
      const line = normalizeLine(settings.inbound_line);
      if (!line) return fail(response, 503, 'inboundDown');

      const now = clock();
      const at = new Date(now);
      const hourAgo = new Date(now - HOUR_MS);
      const [[phoneCount]] = await pool.execute('SELECT COUNT(*) AS n FROM reader_inbound_challenges WHERE phone = ? AND created_at > ?', [phone, hourAgo]);
      if (Number(phoneCount.n) >= INBOUND_REQUESTS_PER_PHONE_PER_HOUR) return fail(response, 429, 'phoneLimit', { retry_after: 3600 });
      const [[ipCount]] = await pool.execute('SELECT COUNT(*) AS n FROM reader_inbound_challenges WHERE ip = ? AND created_at > ?', [request.ip ?? null, hourAgo]);
      if (Number(ipCount.n) >= INBOUND_REQUESTS_PER_IP_PER_HOUR) return fail(response, 429, 'ipLimit', { retry_after: 3600 });
      const [[openCount]] = await pool.execute(
        'SELECT COUNT(*) AS n FROM reader_inbound_challenges WHERE phone = ? AND confirmed_at IS NULL AND consumed_at IS NULL AND expires_at > ?',
        [phone, at],
      );
      if (Number(openCount.n) >= INBOUND_MAX_OPEN_PER_PHONE) return fail(response, 429, 'openLimit', { retry_after: 300 });

      // A new request for this number cancels its older ones (also one that was confirmed but never picked up).
      await pool.execute(
        'UPDATE reader_inbound_challenges SET expires_at = ?, consumed_at = ? WHERE phone = ? AND consumed_at IS NULL',
        [at, at, phone],
      );
      const code = generateOtp();
      const handle = generateHandle();
      await pool.execute(
        'INSERT INTO reader_inbound_challenges (phone, code_hash, handle_hash, ip, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
        [phone, hashInboundCode(config.appSecret, phone, code), hashHandle(handle), request.ip ?? null, at, new Date(now + INBOUND_TTL_MS)],
      );
      // Housekeeping with every request: old challenges and old log lines go.
      await pool.execute('DELETE FROM reader_inbound_challenges WHERE expires_at < ?', [new Date(now - 24 * HOUR_MS)]);
      await pool.execute('DELETE FROM reader_inbound_log WHERE created_at < ?', [new Date(now - INBOUND_LOG_KEEP_MS)]);
      return response.json({ ok: true, handle, code, line: lineInternational(line), body: inboundBody(code), expires_in: INBOUND_TTL_MS / 1000 });
    } catch (error) {
      return next(error);
    }
  });

  // 2. The code is checked. A known number gets its session; a new one gets a short-lived token for the signup form.
  router.post('/auth/verify', async (request, response, next) => {
    try {
      const settings = await loadReaderSettings(pool);
      if (!settings.signup_enabled) return fail(response, 403, 'disabled');
      if (settings.auth_method !== 'sms_send') return fail(response, 403, 'methodReceive');
      const phone = normalizePhone(request.body?.phone);
      if (!phone) return fail(response, 400, 'badPhone');
      const code = cleanOtpInput(request.body?.code);
      if (!code) return fail(response, 400, 'badCode');

      const now = clock();
      const [otpRows] = await pool.execute('SELECT id, code_hash FROM reader_otps WHERE phone = ? AND expires_at > ? ORDER BY id DESC LIMIT 1', [phone, new Date(now)]);
      if (!otpRows[0]) return fail(response, 400, 'expired');
      // The attempt is counted before the comparison, and only while attempts are left: parallel guesses cannot exceed the limit.
      const [counted] = await pool.execute('UPDATE reader_otps SET attempts = attempts + 1 WHERE id = ? AND attempts < ?', [otpRows[0].id, OTP_MAX_ATTEMPTS]);
      if (!counted.affectedRows) return fail(response, 400, 'expired');
      if (!sameHex(otpRows[0].code_hash, hashOtp(config.appSecret, phone, code))) {
        const [[state]] = await pool.execute('SELECT attempts FROM reader_otps WHERE id = ?', [otpRows[0].id]);
        const left = Math.max(0, OTP_MAX_ATTEMPTS - Number(state?.attempts ?? OTP_MAX_ATTEMPTS));
        return fail(response, 400, 'wrongCode', { attempts_left: left });
      }
      // A code works once: whoever deletes the row first wins.
      const [used] = await pool.execute('DELETE FROM reader_otps WHERE id = ?', [otpRows[0].id]);
      if (used.affectedRows !== 1) return fail(response, 400, 'expired');
      await pool.execute('DELETE FROM reader_otps WHERE phone = ?', [phone]);

      return response.json(await proofAccepted(request, response, phone, now));
    } catch (error) {
      return next(error);
    }
  });

  // 2b. The number is proven by one of the two methods; what follows is the same: a known number gets its session, a new one a signup token.
  async function proofAccepted(request, response, phone, now, extra = {}) {
    const [users] = await pool.execute('SELECT id, phone, first_name, last_name, is_student, student_no, unit_id FROM reader_users WHERE phone = ?', [phone]);
    if (users[0]) return { ok: true, ...extra, user: await startSession(request, response, users[0]) };
    return { ok: true, ...extra, needs_signup: true, signup_token: signSignupToken(config.appSecret, phone, now) };
  }

  // 3. A new reader's form (after the code was verified).
  router.post('/auth/signup', async (request, response, next) => {
    try {
      const settings = await loadReaderSettings(pool);
      if (!settings.signup_enabled) return fail(response, 403, 'disabled');
      const body = request.body ?? {};
      const proven = readSignupToken(config.appSecret, body.token, clock());
      if (!proven) return fail(response, 400, 'tokenExpired');
      const parsed = parseProfile(body);
      if (parsed.error) return fail(response, 400, parsed.error);
      const { values } = parsed;
      if (!(await unitExists(values.unit_id))) return fail(response, 400, 'unit');
      let userId;
      try {
        const [result] = await pool.execute(
          'INSERT INTO reader_users (phone, first_name, last_name, is_student, student_no, unit_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [proven.phone, values.first_name, values.last_name, values.is_student ? 1 : 0, values.student_no, values.unit_id, new Date(clock())],
        );
        userId = result.insertId;
      } catch (error) {
        const key = duplicateKey(error);
        if (key) return fail(response, 409, key);
        throw error;
      }
      const user = await startSession(request, response, { id: userId, phone: proven.phone, ...values });
      return response.status(201).json({ ok: true, user });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/auth/logout', async (request, response, next) => {
    try {
      const token = readReaderToken(request, config.nodeEnv);
      if (token) await pool.execute('DELETE FROM reader_sessions WHERE token_hash = ?', [hashReaderToken(token)]);
      clearReaderCookie(response, config.nodeEnv);
      return response.json({ ok: true });
    } catch (error) {
      return next(error);
    }
  });

  // Not signed in is an ordinary answer here ({ user: null }), not an error: the reader asks once on every visit.
  router.get('/me', authenticate, (request, response) => response.json({ user: request.reader }));

  router.patch('/me', authenticate, async (request, response, next) => {
    try {
      if (!request.reader) return fail(response, 401, 'signIn');
      if (request.reader.staff) return fail(response, 403, 'staffProfile');
      const body = request.body ?? {};
      if (Object.hasOwn(body, 'phone')) return fail(response, 400, 'phoneFixed');
      const parsed = parseProfile(body, request.reader);
      if (parsed.error) return fail(response, 400, parsed.error);
      const { values } = parsed;
      if (!(await unitExists(values.unit_id))) return fail(response, 400, 'unit');
      try {
        await pool.execute(
          'UPDATE reader_users SET first_name = ?, last_name = ?, is_student = ?, student_no = ?, unit_id = ? WHERE id = ?',
          [values.first_name, values.last_name, values.is_student ? 1 : 0, values.student_no, values.unit_id, request.reader.id],
        );
      } catch (error) {
        const key = duplicateKey(error);
        if (key) return fail(response, 409, key);
        throw error;
      }
      return response.json({ user: { ...request.reader, ...values } });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
