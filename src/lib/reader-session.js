import { createHash, randomBytes } from 'node:crypto';
import { parseCookies } from '../auth/sessions.js';

// Session of a reader account: separate cookie and table from the admin sessions, 90 days, renewed while it is used.
export const READER_SESSION_TTL_MS = 90 * 24 * 60 * 60_000;
export const READER_RENEW_AFTER_MS = 24 * 60 * 60_000;
export const MAX_READER_SESSIONS = 10;

export const readerCookieName = (nodeEnv) => (nodeEnv === 'production' ? '__Host-pnu_reader' : 'pnu_reader');

export function readerCookieOptions(nodeEnv, now) {
  return { httpOnly: true, secure: nodeEnv === 'production', sameSite: 'lax', path: '/', maxAge: READER_SESSION_TTL_MS, expires: new Date(now + READER_SESSION_TTL_MS) };
}

export const hashReaderToken = (token) => createHash('sha256').update(token).digest('hex');

export function setReaderCookie(response, nodeEnv, token, now) {
  response.cookie(readerCookieName(nodeEnv), token, readerCookieOptions(nodeEnv, now));
}

export function clearReaderCookie(response, nodeEnv) {
  response.clearCookie(readerCookieName(nodeEnv), { httpOnly: true, secure: nodeEnv === 'production', sameSite: 'lax', path: '/' });
}

export function readReaderToken(request, nodeEnv) {
  return parseCookies(request.headers.cookie).get(readerCookieName(nodeEnv)) ?? null;
}

export async function createReaderSession(pool, userId, now) {
  const token = randomBytes(32).toString('base64url');
  const at = new Date(now);
  await pool.execute(
    'INSERT INTO reader_sessions (user_id, token_hash, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
    [userId, hashReaderToken(token), new Date(now + READER_SESSION_TTL_MS), at, at],
  );
  // At most MAX_READER_SESSIONS devices per account: the oldest ones are dropped. Expired sessions go too.
  await pool.execute(
    `DELETE FROM reader_sessions WHERE user_id = ? AND id NOT IN (
       SELECT id FROM (SELECT id FROM reader_sessions WHERE user_id = ? ORDER BY id DESC LIMIT ${MAX_READER_SESSIONS}) AS newest)`,
    [userId, userId],
  );
  await pool.execute('DELETE FROM reader_sessions WHERE expires_at < ?', [at]);
  await pool.execute('UPDATE reader_users SET last_login_at = ? WHERE id = ?', [at, userId]);
  return token;
}

export const publicReader = (row) => ({
  id: Number(row.id),
  phone: row.phone,
  first_name: row.first_name,
  last_name: row.last_name,
  is_student: Boolean(row.is_student),
  student_no: row.student_no ?? null,
  unit_id: row.unit_id === null || row.unit_id === undefined ? null : Number(row.unit_id),
});

// Express middleware: sets request.reader (the account or null). A session used after a day gets its 90 days again.
export function readerAuth({ pool, config, clock = Date.now }) {
  return async function authenticate(request, response, next) {
    request.reader = null;
    const token = readReaderToken(request, config.nodeEnv);
    if (!token) return next();
    try {
      const now = clock();
      const [rows] = await pool.execute(
        `SELECT s.id AS session_id, s.last_seen_at, u.id, u.phone, u.first_name, u.last_name, u.is_student, u.student_no, u.unit_id
         FROM reader_sessions s JOIN reader_users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ? LIMIT 1`,
        [hashReaderToken(token), new Date(now)],
      );
      const row = rows[0];
      if (!row) return next();
      request.reader = publicReader(row);
      if (now - new Date(row.last_seen_at).getTime() > READER_RENEW_AFTER_MS) {
        await pool.execute('UPDATE reader_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?', [new Date(now), new Date(now + READER_SESSION_TTL_MS), row.session_id]);
        setReaderCookie(response, config.nodeEnv, token, now);
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}
