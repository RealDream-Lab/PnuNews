import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { createApp } from '../src/app.js';
import { loadIppanelConfig } from '../src/config.js';
import { createIppanelClient } from '../src/lib/ippanel.js';
import {
  cleanOtpInput, cleanPersonName, cleanStudentNumber, hashOtp, maskPhone, generateOtp, normalizeDigits, normalizePhone, readSignupToken, signSignupToken,
} from '../src/lib/reader-auth.js';
import { createSmsBudget } from '../src/lib/sms-budget.js';
import { createReaderAdminRouter } from '../src/routes/readers-admin.js';

const SECRET = 'c'.repeat(64);

// ---------- helpers: phone, names, codes, tokens ----------

test('phone numbers: every usual way of writing an Iranian mobile gives +989...; anything else gives null', () => {
  for (const input of ['09121234567', '9121234567', '989121234567', '+989121234567', '00989121234567', '۰۹۱۲۱۲۳۴۵۶۷', '٠٩١٢١٢٣٤٥٦٧', ' 0912 123 4567 ', '0912-123-4567', '(+98) 912 123 4567']) {
    assert.equal(normalizePhone(input), '+989121234567', input);
  }
  for (const input of ['', null, undefined, 'abc', '0212345678', '0812345678', '912123456', '91212345678', '0091212345678', '+98912123456', '09121234567x', '+1 202 555 0100', 12345]) {
    assert.equal(normalizePhone(input), null, String(input));
  }
  assert.equal(normalizeDigits('۱۲۳٤٥٦abc'), '123456abc');
  assert.equal(maskPhone('+989121234567'), '+98912***4567');
  assert.ok(maskPhone('+989121234567').length <= 16, 'fits the sms_log column');
});

test('names, student numbers and codes are checked and normalised', () => {
  assert.equal(cleanPersonName('  علی '), 'علی');
  assert.equal(cleanPersonName('محمد‌رضا'), 'محمد‌رضا');
  assert.equal(cleanPersonName('كريمي'), 'کریمی', 'Arabic letter forms become Persian');
  assert.equal(cleanPersonName("O'Brien-Smith"), "O'Brien-Smith");
  for (const bad of ['', 'ا', 'علی۱', 'Ali2', '<b>x</b>', 'a'.repeat(61), '12', '-علی', null, undefined]) assert.equal(cleanPersonName(bad), null, String(bad));
  assert.equal(cleanStudentNumber('۴۰۱۲۳۴۵۶۷۸'), '4012345678');
  for (const bad of ['12345', '1'.repeat(15), '40123a', '', null, '4012 345678']) assert.equal(cleanStudentNumber(bad), null, String(bad));
  assert.equal(cleanOtpInput('۱۲۳۴۵۶'), '123456');
  assert.equal(cleanOtpInput(' 123 456 '), '123456');
  for (const bad of ['12345', '1234567', 'abcdef', '', null, 123456.5]) assert.equal(cleanOtpInput(bad), null, String(bad));
});

test('the code has six digits and never starts with 0 (the pattern variable is a number type)', () => {
  for (let i = 0; i < 3000; i += 1) assert.match(generateOtp(), /^[1-9]\d{5}$/);
});

test('the code is stored as a hash that is bound to the phone number, and the signup token is signed, short-lived and tamper-proof', () => {
  const a = hashOtp(SECRET, '+989121234567', '123456');
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, hashOtp(SECRET, '+989121234568', '123456'), 'the same code for another number gives another hash');
  assert.notEqual(a, hashOtp('d'.repeat(64), '+989121234567', '123456'), 'and another secret too');
  assert.ok(!a.includes('123456'));

  const now = 1_000_000;
  const token = signSignupToken(SECRET, '+989121234567', now);
  assert.deepEqual(readSignupToken(SECRET, token, now + 1000), { phone: '+989121234567' });
  assert.equal(readSignupToken(SECRET, token, now + 11 * 60_000), null, 'expired after 10 minutes');
  assert.equal(readSignupToken('d'.repeat(64), token, now), null, 'another secret');
  const [payload, signature] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ p: '+989129999999', e: now + 600_000 })).toString('base64url');
  assert.equal(readSignupToken(SECRET, `${forged}.${signature}`, now), null, 'a changed phone number');
  for (const bad of ['', 'x', `${payload}.`, `.${signature}`, `${payload}.${signature}.x`, null, undefined, 5, 'x'.repeat(500)]) assert.equal(readSignupToken(SECRET, bad, now), null, String(bad));
});

// ---------- configuration ----------

test('ippanel configuration: optional, strict about the address, and dry-run is for development only', () => {
  assert.deepEqual({ ...loadIppanelConfig({}) }, { baseUrl: 'https://edge.ippanel.com/v1', apiKey: '', patternCode: '', patternVariable: 'OPT', fromNumber: '', dryRun: false });
  const full = loadIppanelConfig({ IPPANEL_BASE_URL: 'https://edge.ippanel.com/v1/', IPPANEL_API_KEY: ' key ', IPPANEL_PATTERN_CODE: 'abc', IPPANEL_FROM_NUMBER: '+983000505', NODE_ENV: 'production' });
  assert.equal(full.baseUrl, 'https://edge.ippanel.com/v1', 'no trailing slash');
  assert.equal(full.apiKey, 'key');
  assert.equal(loadIppanelConfig({ IPPANEL_API_KEY: 'CHANGE_ME' }).apiKey, '', 'a sample value counts as not set');
  assert.throws(() => loadIppanelConfig({ IPPANEL_BASE_URL: 'http://edge.ippanel.com/v1' }), /https/);
  assert.throws(() => loadIppanelConfig({ IPPANEL_BASE_URL: 'http://localhost:9000', NODE_ENV: 'production' }), /https/);
  assert.doesNotThrow(() => loadIppanelConfig({ IPPANEL_BASE_URL: 'http://localhost:9000', NODE_ENV: 'development' }));
  assert.throws(() => loadIppanelConfig({ IPPANEL_FROM_NUMBER: '3000505' }), /E\.164|\+983000505/);
  assert.equal(loadIppanelConfig({ IPPANEL_PATTERN_VARIABLE: 'otp_code' }).patternVariable, 'otp_code');
  for (const bad of ['%OPT%', 'OPT code', '1x', 'عدد']) assert.throws(() => loadIppanelConfig({ IPPANEL_PATTERN_VARIABLE: bad }), /PATTERN_VARIABLE/, bad);
  assert.equal(loadIppanelConfig({ IPPANEL_DRY_RUN: '1', NODE_ENV: 'development' }).dryRun, true);
  assert.throws(() => loadIppanelConfig({ IPPANEL_DRY_RUN: '1', NODE_ENV: 'production' }), /DRY_RUN/, 'codes must never be printed in production');
});

// ---------- the ippanel client ----------

function mockFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    const answer = await handler(url, init, calls.length);
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}
const SUCCESS = { body: { data: { message_outbox_ids: [1123594208] }, meta: { status: true, message: 'انجام شد', message_code: '200-1' } } };
const CREDIT = (credit) => ({ body: { data: { credit, updated_at: '2026-11-20 10:00:00' }, meta: { status: true, message_code: '200-1' } } });
const CLIENT = { baseUrl: 'https://edge.ippanel.com/v1', apiKey: 'SECRET-KEY', patternCode: 'pat123', fromNumber: '+983000505' };

test('ippanel send: the request is exactly the documented one, and success needs meta.status and an outbox id', async () => {
  const fetchImpl = mockFetch(() => SUCCESS);
  const client = createIppanelClient({ ...CLIENT, fetchImpl });
  assert.equal(client.configured, true);
  const result = await client.sendPattern('+989121234567', '654321');
  assert.deepEqual(result, { ok: true, outboxId: '1123594208' });
  const [call] = fetchImpl.calls;
  assert.equal(call.url, 'https://edge.ippanel.com/v1/api/send');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'SECRET-KEY', 'the raw key, no Bearer');
  assert.equal(call.init.headers['Content-Type'], 'application/json');
  assert.equal(call.init.redirect, 'error', 'the key never follows a redirect');
  assert.deepEqual(call.body, { sending_type: 'pattern', from_number: '+983000505', code: 'pat123', recipients: ['+989121234567'], params: { OPT: '654321' } });
  assert.equal(call.body.recipients.length, 1, 'one recipient per request');
  assert.ok(!('phonebook' in call.body));
  const custom = mockFetch(() => SUCCESS);
  await createIppanelClient({ ...CLIENT, patternVariable: 'otp_code', fetchImpl: custom }).sendPattern('+989121234567', '111222');
  assert.deepEqual(custom.calls[0].body.params, { otp_code: '111222' }, 'the variable name is configurable');
});

test('ippanel send: every kind of failure is told apart, and nothing secret is in the result', async () => {
  const cases = [
    ['bad key', { status: 401, body: { data: null, meta: { status: false, message: 'اطلاعات وارد شده صحیح نمی باشد', message_code: '400-1', errors: {} } } }, { kind: 'rejected', status: 401, messageCode: '400-1' }],
    ['validation', { status: 422, body: { data: null, meta: { status: false, message: 'x', message_code: '400-2' } } }, { kind: 'rejected', status: 422, messageCode: '400-2' }],
    ['200 but status false', { body: { data: null, meta: { status: false, message_code: '500-9' } } }, { kind: 'rejected', status: 200, messageCode: '500-9' }],
    ['200 but no outbox id', { body: { data: { message_outbox_ids: [] }, meta: { status: true } } }, { kind: 'rejected', status: 200, messageCode: null }],
    ['200 but no data', { body: { meta: { status: true } } }, { kind: 'rejected', status: 200, messageCode: null }],
  ];
  for (const [name, answer, expected] of cases) {
    const client = createIppanelClient({ ...CLIENT, fetchImpl: mockFetch(() => answer) });
    const result = await client.sendPattern('+989121234567', '111111');
    assert.deepEqual(result, { ok: false, ...expected }, name);
    const text = JSON.stringify(result);
    assert.ok(!text.includes('SECRET-KEY') && !text.includes('111111') && !text.includes('9121234567'), name);
  }
  const html = createIppanelClient({ ...CLIENT, fetchImpl: async () => new Response('<html>Bad gateway</html>', { status: 502 }) });
  assert.equal((await html.sendPattern('+989121234567', '1')).kind, 'invalid_response');
  const timeout = createIppanelClient({ ...CLIENT, fetchImpl: async () => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }); } });
  assert.deepEqual(await timeout.sendPattern('+989121234567', '1'), { ok: false, kind: 'timeout' });
  const down = createIppanelClient({ ...CLIENT, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  assert.deepEqual(await down.sendPattern('+989121234567', '1'), { ok: false, kind: 'network' });
  const unset = createIppanelClient({ fetchImpl: async () => { throw new Error('must not be called'); } });
  assert.equal(unset.configured, false);
  assert.deepEqual(await unset.sendPattern('+989121234567', '1'), { ok: false, kind: 'not_configured' });
});

test('ippanel is never retried by the client: one send is one request, even after a timeout', async () => {
  let requests = 0;
  const client = createIppanelClient({ ...CLIENT, fetchImpl: async () => { requests += 1; throw Object.assign(new Error('x'), { name: 'TimeoutError' }); } });
  await client.sendPattern('+989121234567', '1');
  assert.equal(requests, 1);
});

test('ippanel credit: read in rial; a malformed answer is a failure; dry-run needs no network', async () => {
  const fetchImpl = mockFetch(() => CREDIT(6084722932.705052));
  const client = createIppanelClient({ ...CLIENT, fetchImpl });
  assert.deepEqual(await client.getCredit(), { ok: true, credit: 6084722932.705052, updatedAt: '2026-11-20 10:00:00' });
  assert.equal(fetchImpl.calls[0].url, 'https://edge.ippanel.com/v1/api/payment/credit/mine');
  assert.equal(fetchImpl.calls[0].init.method, 'GET');
  for (const bad of [{ body: { data: { credit: '5' }, meta: { status: true } } }, { body: { data: { credit: -1 }, meta: { status: true } } }, { body: { data: null, meta: { status: false, message_code: '400-1' } }, status: 401 }]) {
    assert.equal((await createIppanelClient({ ...CLIENT, fetchImpl: mockFetch(() => bad) }).getCredit()).ok, false);
  }
  const logged = [];
  const dry = createIppanelClient({ dryRun: true, logger: { info: (text) => logged.push(text) }, fetchImpl: async () => { throw new Error('no network in dry-run'); } });
  assert.equal(dry.configured, true);
  assert.deepEqual(await dry.sendPattern('+989121234567', '123456'), { ok: true, outboxId: 'dry-run', dryRun: true });
  assert.equal((await dry.getCredit()).ok, true);
  assert.equal(logged.length, 1);
  assert.ok(logged[0].includes('123456'), 'dry-run shows the code, so a developer can log in');
});

// ---------- an in-memory database that answers exactly the statements the reader code uses ----------

function memoryDatabase({ settings = {} } = {}) {
  const db = { settings: new Map(Object.entries(settings)), otps: [], users: [], sessions: [], smsLog: [], audit: [], regions: [{ id: 51, type: 'city', visibility_override: 'auto' }, { id: 50, type: 'province', visibility_override: 'auto' }], counters: {}, statements: [] };
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

const config = (overrides = {}) => ({
  publicUrl: 'http://localhost', nodeEnv: 'development', trustProxy: false, appSecret: SECRET, uploadDir: '/tmp/u',
  ippanel: { ...CLIENT }, ...overrides,
});

async function httpCall(server, path, { method = 'GET', body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (body !== undefined) { headers['content-type'] = 'application/json'; headers.origin = `http://127.0.0.1:${server.address().port}`; }
    if (cookie) headers.cookie = cookie;
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: text ? JSON.parse(text) : null, cookie: (res.headers['set-cookie'] ?? []).map((line) => line.split(';')[0]).find((pair) => pair.startsWith('pnu_reader=')) }));
    });
    req.on('error', reject);
    req.end(body !== undefined ? JSON.stringify(body) : undefined);
  });
}

// An app over the in-memory database, a controllable clock and a fake ippanel; `run` gets helpers to talk to it.
async function withReaderApp({ settings = { reader_signup_enabled: '1' }, ippanelAnswer = () => SUCCESS, creditAnswer = () => CREDIT(50_000_000), configOverrides } = {}, run) {
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
    return await run({ db, clock, fetchImpl, call, requestCode, verify, signup, register, sentCodes, form });
  } finally {
    console.warn = quiet;
    server.close();
    server.closeAllConnections?.();
  }
}

// ---------- requesting a code ----------

test('request-code: signup off means no SMS and no trace; the other gates answer before anything is sent', async () => {
  await withReaderApp({ settings: {} }, async ({ db, fetchImpl, requestCode }) => {
    const off = await requestCode();
    assert.equal(off.status, 403);
    assert.equal(off.json.code, 'disabled');
    assert.equal(fetchImpl.calls.length, 0, 'not even the credit was asked');
    assert.equal(db.otps.length + db.smsLog.length, 0);
  });
  await withReaderApp({}, async ({ db, fetchImpl, requestCode }) => {
    for (const phone of ['', 'abc', '0212345678', null]) assert.equal((await requestCode(phone)).status, 400, String(phone));
    assert.equal(fetchImpl.calls.length, 0);
    assert.equal(db.otps.length, 0);
  });
  await withReaderApp({ configOverrides: { ippanel: { baseUrl: CLIENT.baseUrl } } }, async ({ db, requestCode }) => {
    const unconfigured = await requestCode();
    assert.equal(unconfigured.status, 503);
    assert.ok(!/ippanel|IPPANEL|key|کلید/i.test(unconfigured.json.error), 'the reader is told nothing about the setup');
    assert.equal(db.otps.length, 0);
  });
});

test('request-code: one pattern SMS with a 6-digit code; only its hash is stored; the answer never carries the code', async () => {
  await withReaderApp({}, async ({ db, fetchImpl, requestCode, sentCodes }) => {
    const answer = await requestCode('۰۹۱۲۱۲۳۴۵۶۷');
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.json, { ok: true, resend_after: 60, expires_in: 180 });
    assert.equal(answer.headers['cache-control'], 'no-store');
    const [code] = sentCodes();
    assert.match(code, /^\d{6}$/);
    const send = fetchImpl.calls.find((call) => call.url.endsWith('/api/send'));
    assert.deepEqual(send.body.recipients, ['+989121234567']);
    assert.ok(!JSON.stringify(answer.json).includes(code));
    assert.equal(db.otps.length, 1);
    assert.equal(db.otps[0].code_hash, hashOtp(SECRET, '+989121234567', code));
    assert.ok(!JSON.stringify(db.otps).includes(code), 'the code itself is not in the database');
    assert.equal(db.otps[0].expires_at - db.otps[0].created_at, 180_000);
    assert.deepEqual(db.smsLog.map((row) => [row.masked_phone, row.ok, row.outbox_id]), [['+98912***4567', 1, '1123594208']]);
    assert.ok(!JSON.stringify(db.smsLog).includes(code));
  });
});

test('request-code: a 60 second gap, 5 codes per number per hour and 10 per address per hour', async () => {
  await withReaderApp({}, async ({ clock, requestCode, sentCodes }) => {
    assert.equal((await requestCode()).status, 200);
    clock.now += 30_000;
    const soon = await requestCode();
    assert.equal(soon.status, 429);
    assert.equal(soon.json.code, 'tooSoon');
    assert.equal(soon.json.retry_after, 30);
    assert.equal(soon.headers['retry-after'], '30');
    assert.equal(sentCodes().length, 1, 'no second SMS');
    for (let i = 0; i < 4; i += 1) { clock.now += 61_000; assert.equal((await requestCode()).status, 200, `code ${i + 2}`); }
    clock.now += 61_000;
    const sixth = await requestCode();
    assert.equal(sixth.status, 429);
    assert.equal(sixth.json.code, 'phoneLimit');
    assert.equal(sentCodes().length, 5);
    clock.now += 3600_000;
    assert.equal((await requestCode()).status, 200, 'an hour later it works again');
  });
  await withReaderApp({}, async ({ clock, requestCode, sentCodes }) => {
    for (let i = 0; i < 10; i += 1) { assert.equal((await requestCode(`0912000000${i}`)).status, 200); clock.now += 1000; }
    const eleventh = await requestCode('09120000099');
    assert.equal(eleventh.status, 429);
    assert.equal(eleventh.json.code, 'ipLimit');
    assert.equal(sentCodes().length, 10);
  });
});

test('request-code: a failed send is reported generically, logged, never repeated, and its code cannot be used', async () => {
  await withReaderApp({ ippanelAnswer: () => ({ status: 401, body: { data: null, meta: { status: false, message: 'اطلاعات وارد شده صحیح نمی باشد', message_code: '400-1' } } }) }, async ({ db, fetchImpl, requestCode, verify, sentCodes }) => {
    const answer = await requestCode();
    assert.equal(answer.status, 502);
    assert.equal(answer.json.code, 'sendFailed');
    assert.ok(!JSON.stringify(answer.json).includes('400-1') && !JSON.stringify(answer.json).includes('اطلاعات وارد شده'), 'the reader never sees ippanel\'s words');
    assert.equal(fetchImpl.calls.filter((call) => call.url.endsWith('/api/send')).length, 1, 'one attempt');
    assert.deepEqual(db.smsLog.map((row) => [row.ok, row.message_code]), [[0, '400-1']]);
    const [code] = sentCodes();
    assert.equal((await verify(code)).json.code, 'expired', 'a code that never went out does not verify');
  });
});

test('request-code: the daily cap and the credit guard keep the budget; a low credit switches signup off by itself and says why', async () => {
  await withReaderApp({ settings: { reader_signup_enabled: '1', sms_daily_cap: '2' } }, async ({ clock, requestCode, sentCodes }) => {
    assert.equal((await requestCode('09120000001')).status, 200);
    assert.equal((await requestCode('09120000002')).status, 200);
    const third = await requestCode('09120000003');
    assert.equal(third.status, 503);
    assert.equal(third.json.code, 'busy');
    assert.equal(sentCodes().length, 2);
    clock.now += 25 * 3600_000;
    assert.equal((await requestCode('09120000004')).status, 200, 'the cap is about the last 24 hours');
  });
  // 100,000 rial at 2,000 rial per SMS = 50 SMS left, below the minimum of 200
  await withReaderApp({ creditAnswer: () => CREDIT(100_000) }, async ({ db, requestCode, sentCodes }) => {
    const answer = await requestCode();
    assert.equal(answer.status, 403);
    assert.equal(answer.json.code, 'disabled');
    assert.equal(sentCodes().length, 0, 'no SMS was sent');
    assert.equal(db.settings.get('reader_signup_enabled'), '0', 'signup switched itself off');
    const info = JSON.parse(db.settings.get('reader_signup_disabled_info'));
    assert.equal(info.reason, 'low_credit');
    assert.equal(info.remaining, 50);
    assert.equal(db.audit.length, 1);
    assert.equal((await requestCode()).json.code, 'disabled', 'and it stays off');
    assert.equal(db.audit.length, 1, 'one notice, not one per request');
  });
});

test('five failed sends in ten minutes switch signup off; an ippanel that cannot give the credit does not block sending', async () => {
  await withReaderApp({ ippanelAnswer: () => ({ status: 500, body: { data: null, meta: { status: false, message_code: '500-1' } } }) }, async ({ db, clock, requestCode }) => {
    for (let i = 0; i < 5; i += 1) { assert.equal((await requestCode(`0912000000${i}`)).status, 502); clock.now += 5_000; }
    assert.equal(db.settings.get('reader_signup_enabled'), '0');
    assert.equal(JSON.parse(db.settings.get('reader_signup_disabled_info')).reason, 'send_failures');
    assert.equal((await requestCode('09120000009')).status, 403);
  });
  await withReaderApp({ creditAnswer: () => ({ status: 500, body: { data: null, meta: { status: false, message_code: '500-1' } } }) }, async ({ db, requestCode, sentCodes }) => {
    assert.equal((await requestCode()).status, 200, 'the credit lookup failing is not a reason to refuse a reader');
    assert.equal(sentCodes().length, 1);
    assert.equal(db.settings.get('reader_signup_enabled'), '1');
  });
});

// ---------- verifying, signing up, signing in ----------

test('a new reader: code, verification, signup form, session; the same number later signs in with the code alone', async () => {
  await withReaderApp({}, async ({ db, clock, call, requestCode, verify, signup, sentCodes, register }) => {
    const { proven, signed } = await register('09121234567', { is_student: true, student_no: '۴۰۱۲۳۴۵۶۷۸' });
    assert.equal(proven.status, 200);
    assert.equal(proven.json.needs_signup, true);
    assert.equal(proven.cookie, undefined, 'no session before the form');
    assert.equal(signed.status, 201);
    assert.deepEqual(signed.json.user, { id: 1, phone: '+989121234567', first_name: 'علی', last_name: 'رضایی', is_student: true, student_no: '4012345678', unit_id: 51 });
    assert.ok(signed.cookie, 'the session cookie is set');
    assert.ok(!db.sessions.some((s) => s.token_hash === signed.cookie.split('=')[1]), 'only a hash of the token is stored');
    assert.equal(db.sessions.length, 1);
    assert.equal(db.sessions[0].expires_at - db.sessions[0].created_at, 90 * 24 * 3600_000);

    const me = await call('/api/reader/me', { cookie: signed.cookie });
    assert.equal(me.status, 200);
    assert.equal(me.json.user.first_name, 'علی');
    assert.equal(me.headers['cache-control'], 'no-store');
    assert.deepEqual((await call('/api/reader/me')).json, { user: null }, 'not signed in is an ordinary answer');
    assert.deepEqual((await call('/api/reader/me', { cookie: 'pnu_reader=wrong' })).json, { user: null });

    clock.now += 61_000;
    await requestCode();
    const second = await verify(sentCodes().at(-1));
    assert.equal(second.status, 200);
    assert.equal(second.json.needs_signup, undefined, 'an existing reader is not asked for the form again');
    assert.equal(second.json.user.id, 1);
    assert.ok(second.cookie);
    assert.equal(db.sessions.length, 2, 'each device has its own session');
    assert.equal(db.users.length, 1);

    const out = await call('/api/reader/auth/logout', { method: 'POST', body: {}, cookie: second.cookie });
    assert.equal(out.status, 200);
    assert.equal((await call('/api/reader/me', { cookie: second.cookie })).json.user, null, 'the signed-out session is gone');
    assert.equal((await call('/api/reader/me', { cookie: signed.cookie })).status, 200, 'the other device stays signed in');
  });
});

test('verify: 5 attempts, a code works once, an expired or unknown code looks the same, and the digits may be Persian', async () => {
  await withReaderApp({}, async ({ clock, requestCode, verify, sentCodes }) => {
    await requestCode();
    const code = sentCodes()[0];
    const wrong = code === '000000' ? '111111' : '000000';
    for (let left = 4; left >= 0; left -= 1) {
      const attempt = await verify(wrong);
      assert.equal(attempt.status, 400);
      assert.equal(attempt.json.code, 'wrongCode');
      assert.equal(attempt.json.attempts_left, left);
    }
    assert.equal((await verify(code)).json.code, 'expired', 'after 5 wrong tries even the right code is refused');
    clock.now += 61_000;
    await requestCode();
    const fresh = sentCodes()[1];
    const persian = fresh.replace(/\d/g, (digit) => '۰۱۲۳۴۵۶۷۸۹'[digit]);
    assert.equal((await verify(persian)).status, 200, 'Persian digits are accepted');
    assert.equal((await verify(fresh)).json.code, 'expired', 'the same code twice');
  });
  await withReaderApp({}, async ({ clock, requestCode, verify, sentCodes }) => {
    assert.equal((await verify('123456')).json.code, 'expired', 'no code was ever asked for');
    await requestCode();
    clock.now += 181_000;
    assert.equal((await verify(sentCodes()[0])).json.code, 'expired', 'after 3 minutes');
    assert.equal((await verify('12345')).json.code, 'badCode');
    assert.equal((await verify('abcdef')).json.code, 'badCode');
  });
});

test('verify: a code is bound to its number, and signup off or a missing code refuse without touching the accounts', async () => {
  await withReaderApp({}, async ({ requestCode, verify, sentCodes }) => {
    await requestCode('09121234567');
    const answer = await verify(sentCodes()[0], '09129999999');
    assert.equal(answer.status, 400, 'the code of one number does not log in another');
  });
  await withReaderApp({ settings: { reader_signup_enabled: '0' } }, async ({ db, verify, signup }) => {
    assert.equal((await verify('123456')).status, 403);
    assert.equal((await signup('x')).status, 403);
    assert.equal(db.users.length + db.sessions.length, 0);
  });
});

test('signup: the token, the fields and the center are checked; a phone or a student number is never registered twice', async () => {
  await withReaderApp({}, async ({ db, clock, signup, register, requestCode, verify, sentCodes, form }) => {
    assert.equal((await signup('garbage')).json.code, 'tokenExpired');
    assert.equal((await signup(undefined)).json.code, 'tokenExpired');

    await requestCode('09121234567');
    const token = (await verify(sentCodes()[0])).json.signup_token;
    const cases = [
      [{ first_name: '' }, 'firstName'], [{ first_name: 'علی۱' }, 'firstName'], [{ last_name: 'x' }, 'lastName'],
      [{ is_student: 'yes' }, 'student'], [{ is_student: true }, 'studentNo'], [{ is_student: true, student_no: '123' }, 'studentNo'],
      [{ unit_id: undefined }, 'unit'], [{ unit_id: 99999 }, 'unit'], [{ unit_id: 50 }, 'unit'], [{ unit_id: '51; DROP' }, 'unit'],
    ];
    for (const [extra, code] of cases) {
      const answer = await signup(token, extra);
      assert.equal(answer.status, 400, JSON.stringify(extra));
      assert.equal(answer.json.code, code, JSON.stringify(extra));
    }
    assert.equal(db.users.length, 0, 'nothing was created by the refused forms');

    const ok = await signup(token, { is_student: true, student_no: '4012345678' });
    assert.equal(ok.status, 201);
    assert.equal((await signup(token)).json.code, 'phoneTaken', 'the same token cannot register twice');
    assert.equal((await signup(token)).status, 409);

    clock.now += 61_000;
    const second = await register('09127654321', { is_student: true, student_no: '4012345678' });
    assert.equal(second.signed.status, 409);
    assert.equal(second.signed.json.code, 'studentTaken');
    assert.equal(db.users.length, 1);
    const third = await register('09127654322', { is_student: false, student_no: '4012345678' });
    assert.equal(third.signed.status, 201, 'a student number sent by someone who is not a student is ignored');
    assert.equal(third.signed.json.user.student_no, null);
    assert.equal(form.unit_id, 51);
  });
});

test('profile: the reader can change the name, the center and the student number, never the phone; a session lasts 90 days and renews while used', async () => {
  await withReaderApp({}, async ({ db, clock, call, register }) => {
    const { signed } = await register();
    const cookie = signed.cookie;
    const patch = (body) => call('/api/reader/me', { method: 'PATCH', body, cookie });
    assert.equal((await patch({ phone: '09120000000' })).json.code, 'phoneFixed');
    assert.equal((await patch({ first_name: '1' })).status, 400);
    assert.equal((await patch({ is_student: true })).json.code, 'studentNo');
    const changed = await patch({ last_name: 'کریمی', is_student: true, student_no: '4099999999' });
    assert.equal(changed.status, 200);
    assert.equal(changed.json.user.last_name, 'کریمی');
    assert.equal(changed.json.user.first_name, 'علی', 'the fields that were not sent stay');
    assert.equal(db.users[0].student_no, '4099999999');
    assert.equal((await patch({ is_student: false })).json.user.student_no, null, 'no longer a student: the number goes');
    assert.equal((await call('/api/reader/me', { method: 'PATCH', body: { first_name: 'علی' } })).status, 401, 'signed-in readers only');

    const before = db.sessions[0].expires_at;
    clock.now += 2 * 24 * 3600_000;
    const renewed = await call('/api/reader/me', { cookie });
    assert.equal(renewed.status, 200);
    assert.ok(renewed.cookie, 'the cookie is set again');
    assert.equal(db.sessions[0].expires_at - before, 2 * 24 * 3600_000, 'the 90 days start again');
    clock.now += 91 * 24 * 3600_000;
    assert.equal((await call('/api/reader/me', { cookie })).json.user, null, 'an unused session ends after 90 days');
  });
});

test('at most 10 devices per account: the oldest sessions are dropped', async () => {
  await withReaderApp({}, async ({ db, clock, requestCode, verify, sentCodes, register }) => {
    await register();
    for (let i = 0; i < 11; i += 1) {
      clock.now += 61_000;
      if (i % 4 === 3) clock.now += 3600_000; // keeps the per-hour limit out of the way
      await requestCode();
      assert.equal((await verify(sentCodes().at(-1))).status, 200);
    }
    assert.equal(db.sessions.filter((s) => s.user_id === 1).length, 10);
  });
});

// ---------- budget service and admin status ----------

test('the budget: the credit is cached for 5 minutes and follows the sends; a failing lookup is not repeated at once', async () => {
  const db = memoryDatabase({ settings: { reader_signup_enabled: '1' } });
  let now = Date.UTC(2026, 10, 20);
  let lookups = 0;
  let answer = { ok: true, credit: 1_000_000 };
  const ippanel = { configured: true, dryRun: false, getCredit: async () => { lookups += 1; return answer; } };
  const budget = createSmsBudget({ pool: db.pool, ippanel, clock: () => now, events: new EventEmitter(), logger: { warn() {} } });
  assert.deepEqual(await budget.checkBeforeSend(), { allowed: true });
  await budget.checkBeforeSend();
  assert.equal(lookups, 1, 'cached');
  await budget.afterSend({ ok: true }, { costRial: 2000 });
  assert.equal((await budget.status()).credit_rial, 998_000, 'each SMS is taken off the estimate');
  assert.equal((await budget.status()).remaining, 499);
  now += 5 * 60_000 + 1;
  await budget.checkBeforeSend();
  assert.equal(lookups, 2, 'read again after 5 minutes');
  answer = { ok: false, kind: 'timeout' };
  now += 5 * 60_000 + 1;
  assert.deepEqual(await budget.checkBeforeSend(), { allowed: true }, 'a failing lookup never blocks');
  await budget.checkBeforeSend();
  assert.equal(lookups, 3, 'and is not retried within a minute');
  const status = await budget.status();
  assert.equal(status.credit_error.kind, 'timeout');
  assert.equal(status.credit_rial, 1_000_000, 'the last known credit (from the reading before) is still shown');
  const forced = await budget.status({ force: true });
  assert.equal(lookups, 4, 'refresh asks again at once');
  assert.equal(forced.credit_error.kind, 'timeout');
});

test('admin: the SMS status and the settings are the main admin\'s, and switching signup on again clears the notice of an automatic switch-off', async () => {
  const db = memoryDatabase({ settings: { reader_signup_enabled: '0', reader_signup_disabled_info: JSON.stringify({ reason: 'low_credit', at: '2026-11-20T08:00:00.000Z', remaining: 50 }) } });
  db.smsLog.push({ id: 90, masked_phone: '+98912***4567', ip: '1.1.1.1', ok: 0, message_code: '400-1', outbox_id: null, created_at: new Date(Date.UTC(2026, 10, 20, 7, 59)) });
  const ippanel = { configured: true, dryRun: false, getCredit: async () => ({ ok: true, credit: 600_000 }) };
  const budget = createSmsBudget({ pool: db.pool, ippanel, clock: () => Date.UTC(2026, 10, 20, 8, 0), events: new EventEmitter() });
  const app = express();
  app.use(express.json());
  const events = new EventEmitter();
  let role = 'super_admin';
  app.use((req, res, next) => { req.user = { id: 1, role }; next(); });
  app.use('/api/admin/readers', createReaderAdminRouter({ pool: { ...db.pool, getConnection: async () => ({ beginTransaction() {}, commit() {}, rollback() {}, release() {}, execute: db.pool.execute }) }, events, smsBudget: budget }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const status = (await httpCall(server, '/api/admin/readers/sms-status?refresh=1')).json.status;
    assert.equal(status.credit_rial, 600_000);
    assert.equal(status.remaining, 300);
    assert.equal(status.cost_rial, 2000);
    assert.equal(status.sent_24h, 1);
    assert.deepEqual(status.recent_failures, [{ phone: '+98912***4567', code: '400-1', at: '2026-11-20T07:59:00.000Z' }]);
    assert.equal(status.signup_disabled.reason, 'low_credit');
    assert.ok(!JSON.stringify(status).includes('SECRET') && !('api_key' in status));

    const on = await httpCall(server, '/api/admin/readers/settings', { method: 'PUT', body: { signup_enabled: true } });
    assert.equal(on.status, 200);
    assert.equal(db.settings.get('reader_signup_enabled'), '1');
    assert.equal(db.settings.has('reader_signup_disabled_info'), false, 'the notice is gone once the admin switches signup on');

    role = 'city_admin';
    assert.equal((await httpCall(server, '/api/admin/readers/sms-status')).status, 403);
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
  const noBudget = express();
  noBudget.use((req, res, next) => { req.user = { id: 1, role: 'super_admin' }; next(); });
  noBudget.use('/api/admin/readers', createReaderAdminRouter({ pool: db.pool }));
  const second = http.createServer(noBudget);
  await new Promise((resolve) => second.listen(0, '127.0.0.1', resolve));
  try {
    assert.equal((await httpCall(second, '/api/admin/readers/sms-status')).status, 503);
  } finally {
    second.close();
    second.closeAllConnections?.();
  }
});
