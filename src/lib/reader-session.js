import { createHash, randomBytes } from 'node:crypto';
import { parseCookies, readCookie } from '../auth/sessions.js';
import { splitFullName, staffReaderFromRequest, staffView } from './staff-reader.js';

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
  // A valid dashboard session makes the user a reader (their linked account) and gives this browser a reader session of its own,
  // so the account stays on the news page after the 24-hour dashboard session ends.
  async function adoptDashboardSession(request, response, staffToken) {
    const linked = await staffReaderFromRequest(pool, staffToken);
    if (!linked) return;
    request.reader = { ...publicReader(linked.row), staff: linked.staff };
    const now = clock();
    setReaderCookie(response, config.nodeEnv, await createReaderSession(pool, linked.row.id, now), now);
  }

  return async function authenticate(request, response, next) {
    request.reader = null;
    const token = readReaderToken(request, config.nodeEnv);
    try {
      // No reader session: a valid dashboard session makes the user a reader too (their linked account, see staff-reader.js).
      const staffToken = readCookie(request, 'session', config.nodeEnv);
      if (!token && staffToken) {
        await adoptDashboardSession(request, response, staffToken);
        return next();
      }
      if (!token) return next();
      const now = clock();
      // A session of a dashboard user's linked account lives only while that user is active; the post and place come from the user.
      const [rows] = await pool.execute(
        `SELECT s.id AS session_id, s.last_seen_at, u.id, u.phone, u.first_name, u.last_name, u.is_student, u.student_no, u.unit_id, u.staff_user_id,
                su.full_name AS staff_full_name, su.role AS staff_role, su.region_id AS staff_region_id, d.name AS domain_name,
                r.type AS level, r.name AS region_name, p.name AS parent_name
         FROM reader_sessions s JOIN reader_users u ON u.id = s.user_id
         LEFT JOIN users su ON su.id = u.staff_user_id LEFT JOIN regions r ON r.id = su.region_id
         LEFT JOIN regions p ON p.id = r.parent_id LEFT JOIN work_domains d ON d.id = su.domain_id
         WHERE s.token_hash = ? AND s.expires_at > ? AND (u.staff_user_id IS NULL OR su.is_active = 1) LIMIT 1`,
        [hashReaderToken(token), new Date(now)],
      );
      const row = rows[0];
      if (!row) {
        const staffToken = readCookie(request, 'session', config.nodeEnv);
        if (staffToken) await adoptDashboardSession(request, response, staffToken);
        return next();
      }
      request.reader = publicReader(row);
      if (row.staff_user_id) {
        const { first, last } = splitFullName(row.staff_full_name);
        Object.assign(request.reader, { first_name: first, last_name: last, unit_id: Number(row.staff_region_id), staff: staffView({ role: row.staff_role, domain_name: row.domain_name, level: row.level, region_name: row.region_name, parent_name: row.parent_name }) });
      }
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
