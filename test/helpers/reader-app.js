import http from 'node:http';
import { createApp } from '../../src/app.js';

// Shared by the reader tests: a fake ippanel, an in-memory database that answers exactly the statements the reader code uses,
// and an app (the real createApp) over them with a clock the test controls.

export const SECRET = 'c'.repeat(64);
export const INBOUND_KEY = 'ab'.repeat(32);
export const INBOUND_LINE = '985000262720';
// Settings of an app that has the receiving method switched on.
export const RECEIVE_SETTINGS = Object.freeze({ reader_signup_enabled: '1', reader_auth_method: 'sms_receive', reader_inbound_line: INBOUND_LINE, reader_inbound_key: INBOUND_KEY });

export function mockFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    const answer = await handler(url, init, calls.length);
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}
export const SUCCESS = { body: { data: { message_outbox_ids: [1123594208] }, meta: { status: true, message: 'انجام شد', message_code: '200-1' } } };
export const CREDIT = (credit) => ({ body: { data: { credit, updated_at: '2026-11-20 10:00:00' }, meta: { status: true, message_code: '200-1' } } });
export const CLIENT = { baseUrl: 'https://edge.ippanel.com/v1', apiKey: 'SECRET-KEY', patternCode: 'pat123', fromNumber: '+983000505' };

// ---------- an in-memory database that answers exactly the statements the reader code uses ----------

export function memoryDatabase({ settings = {} } = {}) {
  const db = { staffSessions: new Map(), settings: new Map(Object.entries(settings)), otps: [], challenges: [], inboundLog: [], users: [], sessions: [], smsLog: [], audit: [], regions: [{ id: 51, type: 'city', visibility_override: 'auto' }, { id: 50, type: 'province', visibility_override: 'auto' }], counters: {}, statements: [] };
  const id = (table) => { db.counters[table] = (db.counters[table] ?? 0) + 1; return db.counters[table]; };
  const duplicate = (key, value) => Object.assign(new Error(`Duplicate entry '${value}' for key '${key}'`), { code: 'ER_DUP_ENTRY' });
  const rows = (list) => [list, []];
  const done = (extra = {}) => [{ affectedRows: 1, insertId: 0, ...extra }, undefined];
  const userRow = (u) => ({ id: u.id, phone: u.phone, first_name: u.first_name, last_name: u.last_name, is_student: u.is_student, student_no: u.student_no, unit_id: u.unit_id });
  const handlers = [
    [/^SELECT k, v FROM settings WHERE k IN \(\?\)$/, ([keys]) => rows([...db.settings].filter(([k]) => keys.includes(k)).map(([k, v]) => ({ k, v })))],
    [/^SELECT v FROM settings WHERE k = \?$/, ([k]) => rows(db.settings.has(k) ? [{ v: db.settings.get(k) }] : [])],
    [/^UPDATE settings SET v = '0' WHERE k = 'reader_signup_enabled' AND v = '1'$/, () => { const on = db.settings.get('reader_signup_enabled') === '1'; if (on) db.settings.set('reader_signup_enabled', '0'); return done({ affectedRows: on ? 1 : 0 }); }],
    [/^INSERT INTO settings \(k, v\) VALUES \(\?, \?\) ON DUPLICATE KEY UPDATE v = VALUES\(v\)$/, ([k, v]) => { db.settings.set(k, v); return done(); }],
    [/^DELETE FROM settings WHERE k = \?$/, ([k]) => { db.settings.delete(k); return done(); }],
    [/^INSERT INTO audit_log/, (params) => { db.audit.push(params); return done(); }],
    [/^SELECT created_at FROM reader_otps WHERE phone = \? ORDER BY id DESC LIMIT 1$/, ([phone]) => rows(db.otps.filter((o) => o.phone === phone).sort((a, b) => b.id - a.id).slice(0, 1).map((o) => ({ created_at: o.created_at })))],
    [/^SELECT COUNT\(\*\) AS n FROM reader_otps WHERE phone = \? AND created_at > \?$/, ([phone, since]) => rows([{ n: db.otps.filter((o) => o.phone === phone && o.created_at > since).length }])],
    [/^SELECT COUNT\(\*\) AS n FROM reader_otps WHERE ip = \? AND created_at > \?$/, ([ip, since]) => rows([{ n: db.otps.filter((o) => o.ip === ip && o.created_at > since).length }])],
    [/^INSERT INTO reader_otps \(phone, code_hash, expires_at, ip, created_at\)/, ([phone, code_hash, expires_at, ip, created_at]) => { const row = { id: id('otps'), phone, code_hash, expires_at, ip, created_at, attempts: 0 }; db.otps.push(row); return done({ insertId: row.id }); }],
    [/^UPDATE reader_otps SET expires_at = \? WHERE id = \?$/, ([at, otpId]) => { const row = db.otps.find((o) => o.id === otpId); if (row) row.expires_at = at; return done(); }],
    [/^DELETE FROM sms_log WHERE created_at < \?$/, ([at]) => { db.smsLog = db.smsLog.filter((l) => !(l.created_at < at)); return done(); }],
    [/^DELETE FROM reader_otps WHERE expires_at < \?$/, ([at]) => { db.otps = db.otps.filter((o) => !(o.expires_at < at)); return done(); }],
    [/^SELECT id, code_hash FROM reader_otps WHERE phone = \? AND expires_at > \? ORDER BY id DESC LIMIT 1$/, ([phone, now]) => rows(db.otps.filter((o) => o.phone === phone && o.expires_at > now).sort((a, b) => b.id - a.id).slice(0, 1).map((o) => ({ id: o.id, code_hash: o.code_hash })))],
    [/^UPDATE reader_otps SET attempts = attempts \+ 1 WHERE id = \? AND attempts < \?$/, ([otpId, max]) => { const row = db.otps.find((o) => o.id === otpId && o.attempts < max); if (row) row.attempts += 1; return done({ affectedRows: row ? 1 : 0 }); }],
    [/^SELECT attempts FROM reader_otps WHERE id = \?$/, ([otpId]) => rows(db.otps.filter((o) => o.id === otpId).map((o) => ({ attempts: o.attempts })))],
    [/^DELETE FROM reader_otps WHERE id = \?$/, ([otpId]) => { const before = db.otps.length; db.otps = db.otps.filter((o) => o.id !== otpId); return done({ affectedRows: before - db.otps.length }); }],
    [/^DELETE FROM reader_otps WHERE phone = \?$/, ([phone]) => { db.otps = db.otps.filter((o) => o.phone !== phone); return done(); }],
    [/^INSERT INTO sms_log \(masked_phone, ip, ok, message_code, outbox_id, created_at\)/, ([masked_phone, ip, ok, message_code, outbox_id, created_at]) => { db.smsLog.push({ id: id('smsLog'), masked_phone, ip, ok, message_code, outbox_id, created_at }); return done(); }],
    [/^SELECT COUNT\(\*\) AS n FROM sms_log WHERE created_at > \?$/, ([since]) => rows([{ n: db.smsLog.filter((l) => l.created_at > since).length }])],
    [/^SELECT COUNT\(\*\) AS n FROM sms_log WHERE ok = 0 AND created_at > \?$/, ([since]) => rows([{ n: db.smsLog.filter((l) => l.ok === 0 && l.created_at > since).length }])],
    [/^SELECT masked_phone, message_code, created_at FROM sms_log WHERE ok = 0 ORDER BY id DESC LIMIT 20$/, () => rows(db.smsLog.filter((l) => l.ok === 0).sort((a, b) => b.id - a.id).slice(0, 20))],
    [/^SELECT id, phone, first_name, last_name, is_student, student_no, unit_id FROM reader_users WHERE phone = \?$/, ([phone]) => rows(db.users.filter((u) => u.phone === phone).map(userRow))],
    [/^SELECT id FROM regions WHERE id = \? AND type = 'city' AND visibility_override <> 'hide' LIMIT 1$/, ([unitId]) => rows(db.regions.filter((r) => r.id === unitId && r.type === 'city' && r.visibility_override !== 'hide').map((r) => ({ id: r.id })))],
    [/^INSERT INTO reader_users \(phone, first_name, last_name, is_student, student_no, unit_id, created_at\)/, ([phone, first_name, last_name, is_student, student_no, unit_id]) => {
      if (db.users.some((u) => u.phone === phone)) throw duplicate('uq_reader_phone', phone);
      if (student_no && db.users.some((u) => u.student_no === student_no)) throw duplicate('uq_reader_student_no', student_no);
      const row = { id: id('users'), phone, first_name, last_name, is_student, student_no, unit_id, last_login_at: null };
      db.users.push(row);
      return done({ insertId: row.id });
    }],
    [/^UPDATE reader_users SET first_name = \?, last_name = \?, is_student = \?, student_no = \?, unit_id = \? WHERE id = \?$/, ([first, last, student, studentNo, unitId, userId]) => {
      if (studentNo && db.users.some((u) => u.student_no === studentNo && u.id !== userId)) throw duplicate('uq_reader_student_no', studentNo);
      Object.assign(db.users.find((u) => u.id === userId), { first_name: first, last_name: last, is_student: student, student_no: studentNo, unit_id: unitId });
      return done();
    }],
    [/^UPDATE reader_users SET last_login_at = \? WHERE id = \?$/, ([at, userId]) => { db.users.find((u) => u.id === userId).last_login_at = at; return done(); }],
    [/^INSERT INTO reader_sessions \(user_id, token_hash, expires_at, created_at, last_seen_at\)/, ([user_id, token_hash, expires_at, created_at, last_seen_at]) => { const row = { id: id('sessions'), user_id, token_hash, expires_at, created_at, last_seen_at }; db.sessions.push(row); return done({ insertId: row.id }); }],
    [/^DELETE FROM reader_sessions WHERE user_id = \? AND id NOT IN/, ([userId]) => { const keep = new Set(db.sessions.filter((s) => s.user_id === userId).sort((a, b) => b.id - a.id).slice(0, 10).map((s) => s.id)); db.sessions = db.sessions.filter((s) => s.user_id !== userId || keep.has(s.id)); return done(); }],
    [/^DELETE FROM reader_sessions WHERE expires_at < \?$/, ([at]) => { db.sessions = db.sessions.filter((s) => !(s.expires_at < at)); return done(); }],
    [/^DELETE FROM reader_sessions WHERE token_hash = \?$/, ([hash]) => { db.sessions = db.sessions.filter((s) => s.token_hash !== hash); return done(); }],
    [/^SELECT s\.id AS session_id, s\.last_seen_at, u\.id, u\.phone/, ([hash, now]) => rows(db.sessions.filter((s) => s.token_hash === hash && s.expires_at > now).map((s) => ({ session_id: s.id, last_seen_at: s.last_seen_at, ...userRow(db.users.find((u) => u.id === s.user_id)) })).slice(0, 1))],
    // ---- dashboard users as readers (linked accounts) ----
    [/^SELECT u\.id AS staff_id, u\.full_name, u\.role, u\.region_id, d\.name AS domain_name, r\.type AS level, r\.name AS region_name, p\.name AS parent_name FROM sessions s/, ([hash]) => rows([db.staffSessions.get(Buffer.from(hash).toString('hex'))].filter(Boolean).map((x) => ({ ...x })))],
    [/^SELECT id, phone, first_name, last_name, is_student, student_no, unit_id FROM reader_users WHERE staff_user_id = \? LIMIT 1$/, ([staffId]) => rows(db.users.filter((u) => u.staff_user_id === staffId).slice(0, 1).map(userRow))],
    [/^INSERT IGNORE INTO reader_users \(phone, first_name, last_name, is_student, student_no, unit_id, staff_user_id\) VALUES \(NULL, \?, \?, 0, NULL, \?, \?\)$/, ([first_name, last_name, unit_id, staff_user_id]) => {
      if (db.users.some((u) => u.staff_user_id === staff_user_id)) return done({ affectedRows: 0 });
      db.users.push({ id: id('users'), phone: null, first_name, last_name, is_student: 0, student_no: null, unit_id, staff_user_id, created_at: new Date(), last_login_at: null });
      return done();
    }],
    [/^UPDATE reader_users SET first_name = \?, last_name = \?, unit_id = \? WHERE id = \?$/, ([first_name, last_name, unit_id, userId]) => { Object.assign(db.users.find((u) => u.id === userId), { first_name, last_name, unit_id }); return done(); }],
    // ---- the inbound-SMS method (sms_receive) ----
    [/^SELECT COUNT\(\*\) AS n FROM reader_inbound_challenges WHERE phone = \? AND created_at > \?$/, ([phone, since]) => rows([{ n: db.challenges.filter((c) => c.phone === phone && c.created_at > since).length }])],
    [/^SELECT COUNT\(\*\) AS n FROM reader_inbound_challenges WHERE ip = \? AND created_at > \?$/, ([ip, since]) => rows([{ n: db.challenges.filter((c) => c.ip === ip && c.created_at > since).length }])],
    [/^SELECT COUNT\(\*\) AS n FROM reader_inbound_challenges WHERE phone = \? AND confirmed_at IS NULL AND consumed_at IS NULL AND expires_at > \?$/, ([phone, now]) => rows([{ n: db.challenges.filter((c) => c.phone === phone && !c.confirmed_at && !c.consumed_at && c.expires_at > now).length }])],
    [/^UPDATE reader_inbound_challenges SET expires_at = \?, consumed_at = \? WHERE phone = \? AND consumed_at IS NULL$/, ([expires, consumed, phone]) => { const hit = db.challenges.filter((c) => c.phone === phone && !c.consumed_at); hit.forEach((c) => { c.expires_at = expires; c.consumed_at = consumed; }); return done({ affectedRows: hit.length }); }],
    [/^INSERT INTO reader_inbound_challenges \(phone, code_hash, handle_hash, ip, created_at, expires_at\) VALUES/, ([phone, code_hash, handle_hash, ip, created_at, expires_at]) => {
      if (db.challenges.some((c) => c.handle_hash === handle_hash)) throw duplicate('uq_reader_inbound_handle', handle_hash);
      const row = { id: id('challenges'), phone, code_hash, handle_hash, ip, created_at, expires_at, confirmed_at: null, consumed_at: null };
      db.challenges.push(row);
      return done({ insertId: row.id });
    }],
    [/^DELETE FROM reader_inbound_challenges WHERE expires_at < \?$/, ([at]) => { db.challenges = db.challenges.filter((c) => !(c.expires_at < at)); return done(); }],
    [/^DELETE FROM reader_inbound_log WHERE created_at < \?$/, ([at]) => { db.inboundLog = db.inboundLog.filter((l) => !(l.created_at < at)); return done(); }],
    [/^SELECT id, phone, expires_at, confirmed_at, consumed_at FROM reader_inbound_challenges WHERE handle_hash = \? LIMIT 1$/, ([hash]) => rows(db.challenges.filter((c) => c.handle_hash === hash).slice(0, 1).map((c) => ({ ...c })))],
    [/^UPDATE reader_inbound_challenges SET consumed_at = \? WHERE id = \? AND handle_hash = \? AND confirmed_at IS NOT NULL AND consumed_at IS NULL AND confirmed_at > \?$/, ([at, challengeId, hash, since]) => {
      const row = db.challenges.find((c) => c.id === challengeId && c.handle_hash === hash && c.confirmed_at && !c.consumed_at && c.confirmed_at > since);
      if (row) row.consumed_at = at;
      return done({ affectedRows: row ? 1 : 0 });
    }],
    [/^DELETE FROM reader_inbound_challenges WHERE phone = \? AND id <> \?$/, ([phone, keep]) => { const before = db.challenges.length; db.challenges = db.challenges.filter((c) => c.phone !== phone || c.id === keep); return done({ affectedRows: before - db.challenges.length }); }],
    [/^SELECT id, code_hash FROM reader_inbound_challenges WHERE phone = \? AND confirmed_at IS NULL AND consumed_at IS NULL AND expires_at > \? ORDER BY id DESC$/, ([phone, now]) => rows(db.challenges.filter((c) => c.phone === phone && !c.confirmed_at && !c.consumed_at && c.expires_at > now).sort((a, b) => b.id - a.id).map((c) => ({ id: c.id, code_hash: c.code_hash })))],
    [/^UPDATE reader_inbound_challenges SET confirmed_at = \? WHERE id = \? AND confirmed_at IS NULL AND consumed_at IS NULL AND expires_at > \?$/, ([at, challengeId, now]) => {
      const row = db.challenges.find((c) => c.id === challengeId && !c.confirmed_at && !c.consumed_at && c.expires_at > now);
      if (row) row.confirmed_at = at;
      return done({ affectedRows: row ? 1 : 0 });
    }],
    [/^INSERT INTO reader_inbound_log \(masked_phone, ip, outcome, reason, created_at\) VALUES/, ([masked_phone, ip, outcome, reason, created_at]) => { db.inboundLog.push({ id: id('inboundLog'), masked_phone, ip, outcome, reason, created_at }); return done(); }],
    [/^SELECT masked_phone, ip, outcome, reason, created_at FROM reader_inbound_log ORDER BY id DESC LIMIT 30$/, () => rows(db.inboundLog.slice().sort((a, b) => b.id - a.id).slice(0, 30))],
    [/^UPDATE reader_sessions SET last_seen_at = \?, expires_at = \? WHERE id = \?$/, ([seen, expires, sessionId]) => { Object.assign(db.sessions.find((s) => s.id === sessionId), { last_seen_at: seen, expires_at: expires }); return done(); }],
  ];
  const run = async (sql, params = []) => {
    const text = sql.replace(/\s+/g, ' ').trim();
    db.statements.push(text);
    for (const [pattern, handler] of handlers) if (pattern.test(text)) return handler(params);
    throw new Error(`unhandled SQL in the test database: ${text}`);
  };
  db.pool = { execute: run, query: run };
  return db;
}

export const config = (overrides = {}) => ({
  publicUrl: 'http://localhost', nodeEnv: 'development', trustProxy: false, appSecret: SECRET, uploadDir: '/tmp/u',
  ippanel: { ...CLIENT }, ...overrides,
});

export async function httpCall(server, path, { method = 'GET', body, cookie, form, headers: extraHeaders = {} } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...extraHeaders };
    if (body !== undefined) { headers['content-type'] = 'application/json'; headers.origin = `http://127.0.0.1:${server.address().port}`; }
    if (form !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
    if (cookie) headers.cookie = cookie;
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: /json/.test(res.headers['content-type'] ?? '') && text ? JSON.parse(text) : null, cookie: (res.headers['set-cookie'] ?? []).map((line) => line.split(';')[0]).find((pair) => pair.startsWith('pnu_reader=')) }));
    });
    req.on('error', reject);
    req.end(form !== undefined ? form : (body !== undefined ? JSON.stringify(body) : undefined));
  });
}

// An app over the in-memory database, a controllable clock and a fake ippanel; `run` gets helpers to talk to it.
export async function withReaderApp({ settings = { reader_signup_enabled: '1' }, ippanelAnswer = () => SUCCESS, creditAnswer = () => CREDIT(50_000_000), configOverrides } = {}, run) {
  const db = memoryDatabase({ settings });
  const clock = { now: Date.UTC(2026, 10, 20, 8, 0, 0) };
  const fetchImpl = mockFetch((url, init, count) => (url.endsWith('/api/send') ? ippanelAnswer(JSON.parse(init.body), count) : creditAnswer()));
  const app = createApp({ pool: db.pool, config: config(configOverrides), clock: () => clock.now, fetchImpl, staticAssets: null });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const quiet = console.warn;
  console.warn = () => {};
  try {
    const sentCodes = () => fetchImpl.calls.filter((call) => call.url.endsWith('/api/send')).map((call) => call.body.params.OPT);
    const call = (path, options) => httpCall(server, path, options);
    const requestCode = (phone = '09121234567') => call('/api/reader/auth/request-code', { method: 'POST', body: { phone } });
    const verify = (code, phone = '09121234567') => call('/api/reader/auth/verify', { method: 'POST', body: { phone, code } });
    const form = { first_name: 'علی', last_name: 'رضایی', is_student: false, unit_id: 51 };
    const signup = (token, extra = {}) => call('/api/reader/auth/signup', { method: 'POST', body: { token, ...form, ...extra } });
    // The full way in for a new reader: code, verification, signup form.
    const register = async (phone = '09121234567', extra = {}) => {
      await requestCode(phone);
      const code = sentCodes().at(-1);
      const proven = await verify(code, phone);
      return { code, proven, signed: await signup(proven.json.signup_token, extra) };
    };
    // The inbound-SMS method: the browser asks for a challenge, the provider calls the webhook, the browser asks what became of it.
    const requestInbound = (phone = '09121234567') => call('/api/reader/auth/request-inbound', { method: 'POST', body: { phone } });
    const inboundStatus = (handle) => call('/api/reader/auth/inbound-status', { method: 'POST', body: { handle } });
    const hook = (params = {}, { key = INBOUND_KEY, method = 'GET', ip } = {}) => {
      const all = { ...(key === null ? {} : { key }), ...params };
      const query = new URLSearchParams(all).toString();
      const headers = ip ? { 'x-forwarded-for': ip } : {};
      return method === 'GET' ? call(`/api/reader/auth/sms-in?${query}`, { headers }) : call('/api/reader/auth/sms-in', { method, form: query, headers });
    };
    // A reader's phone sends `message` from `from` to the line, the way ippanel reports it.
    const sendSms = (message, from = '989121234567', to = INBOUND_LINE, options) => hook({ from, to, message }, options);
    return await run({ db, clock, fetchImpl, call, requestCode, verify, signup, register, sentCodes, form, requestInbound, inboundStatus, hook, sendSms });
  } finally {
    console.warn = quiet;
    server.close();
    server.closeAllConnections?.();
  }
}

