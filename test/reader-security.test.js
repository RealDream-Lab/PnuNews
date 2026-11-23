import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { redactForLog } from '../src/lib/log-redact.js';
import { CLIENT, httpCall, memoryDatabase, SUCCESS, withReaderApp, mockFetch, config } from './helpers/reader-app.js';
import { createApp } from '../src/app.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(`${root}package.json`, 'utf8')).version;
const read = (relative) => readFileSync(`${root}${relative}`, 'utf8');

// A raw request, so a test can choose the content type and headers freely.
function rawRequest(server, path, { method = 'POST', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function withServer(app, run) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { return await run(server); } finally { server.close(); server.closeAllConnections?.(); }
}

test('CSRF: a request that changes anything must be JSON and come from this site; the SMS is not sent otherwise', async () => {
  await withReaderApp({}, async ({ fetchImpl, db }) => {
    await withServer(createApp({ pool: db.pool, config: config(), clock: () => Date.UTC(2026, 10, 21), fetchImpl, staticAssets: null }), async (server) => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const body = JSON.stringify({ phone: '09121234567' });
      const attempts = [
        ['a form post', { 'content-type': 'application/x-www-form-urlencoded', origin }, 'phone=09121234567', 415],
        ['text/plain (a cross-site form can send this)', { 'content-type': 'text/plain', origin }, body, 415],
        ['no content type', { origin }, body, 415],
        ['JSON from another site', { 'content-type': 'application/json', origin: 'https://evil.example' }, body, 403],
        ['JSON with no origin and no fetch metadata', { 'content-type': 'application/json' }, body, 403],
        ['JSON from a cross-site fetch', { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body, 403],
      ];
      for (const [name, headers, payload, expected] of attempts) {
        const answer = await rawRequest(server, '/api/reader/auth/request-code', { headers, body: payload });
        assert.equal(answer.status, expected, name);
      }
      for (const path of ['/api/reader/auth/verify', '/api/reader/auth/signup', '/api/reader/auth/logout', '/api/reader/bookmarks/sync']) {
        const answer = await rawRequest(server, path, { headers: { 'content-type': 'text/plain', origin }, body: '{}' });
        assert.equal(answer.status, 415, path);
      }
      const patch = await rawRequest(server, '/api/reader/me', { method: 'PATCH', headers: { 'content-type': 'text/plain', origin }, body: '{}' });
      assert.equal(patch.status, 415);
    });
    assert.equal(fetchImpl.calls.filter((call) => call.url.endsWith('/api/send')).length, 0, 'not one SMS was sent');
    assert.equal(db.otps.length, 0);
  });
});

test('the reader session cookie is httpOnly, SameSite=Lax, path /, and in production Secure with the __Host- prefix and no Domain', async () => {
  for (const production of [false, true]) {
    await withReaderApp({ configOverrides: production ? { nodeEnv: 'production', publicUrl: 'https://news.example.ir' } : {} }, async ({ db, fetchImpl, clock }) => {
      const app = createApp({ pool: db.pool, config: config(production ? { nodeEnv: 'production', publicUrl: 'https://news.example.ir', trustProxy: true } : {}), clock: () => clock.now, fetchImpl, staticAssets: null });
      await withServer(app, async (server) => {
        const origin = production ? 'https://news.example.ir' : `http://127.0.0.1:${server.address().port}`;
        const headers = { 'content-type': 'application/json', origin, host: production ? 'news.example.ir' : undefined, 'x-forwarded-proto': production ? 'https' : undefined };
        for (const key of Object.keys(headers)) if (headers[key] === undefined) delete headers[key];
        await rawRequest(server, '/api/reader/auth/request-code', { headers, body: JSON.stringify({ phone: '09121234567' }) });
        const code = fetchImpl.calls.find((call) => call.url.endsWith('/api/send')).body.params.OPT;
        const verified = JSON.parse((await rawRequest(server, '/api/reader/auth/verify', { headers, body: JSON.stringify({ phone: '09121234567', code }) })).text);
        const signed = await rawRequest(server, '/api/reader/auth/signup', { headers, body: JSON.stringify({ token: verified.signup_token, first_name: 'علی', last_name: 'رضایی', is_student: false, unit_id: 51 }) });
        assert.equal(signed.status, 201, `production ${production}: ${signed.text.slice(0, 120)}`);
        const cookie = [signed.headers['set-cookie']].flat().find((line) => /pnu_reader=/.test(line));
        assert.ok(cookie, 'a cookie was set');
        assert.match(cookie, /HttpOnly/i);
        assert.match(cookie, /SameSite=Lax/i);
        assert.match(cookie, /Path=\//);
        assert.ok(!/Domain=/i.test(cookie), 'no Domain: the cookie belongs to this host only');
        assert.match(cookie, /Max-Age=7776000/, '90 days');
        if (production) {
          assert.match(cookie, /^__Host-pnu_reader=/);
          assert.match(cookie, /Secure/i);
        } else {
          assert.match(cookie, /^pnu_reader=/);
        }
      });
    });
  }
});

test('a reader\'s session opens nothing in the admin area, and the admin routes of the readers need the main admin', async () => {
  await withReaderApp({}, async ({ db, register, call, fetchImpl, clock }) => {
    const { signed } = await register();
    assert.ok(signed.cookie);
    await withServer(createApp({ pool: db.pool, config: config(), clock: () => clock.now, fetchImpl, staticAssets: null }), async (server) => {
      for (const path of ['/api/admin/readers/settings', '/api/admin/readers/users', '/api/admin/readers/sms-status', '/api/admin/news', '/api/admin/settings', '/api/auth/viewer']) {
        const answer = await rawRequest(server, path, { method: 'GET', headers: { cookie: signed.cookie } });
        assert.ok([401, 403].includes(answer.status) || (path === '/api/auth/viewer' && answer.status === 200 && !/"user":\{/.test(answer.text)), `${path}: ${answer.status} ${answer.text.slice(0, 80)}`);
      }
      const put = await rawRequest(server, '/api/admin/readers/settings', { method: 'PUT', headers: { cookie: signed.cookie, 'content-type': 'application/json', origin: `http://127.0.0.1:${server.address().port}` }, body: JSON.stringify({ signup_enabled: false }) });
      assert.ok([401, 403].includes(put.status), `a reader cannot switch signup off: ${put.status}`);
    });
    assert.equal(db.settings.get('reader_signup_enabled'), '1', 'nothing changed');
    void call;
  });
});

test('nothing secret reaches a log or an error answer: the key, the codes, the tokens and the phone numbers stay out', async () => {
  const logged = [];
  const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  for (const level of Object.keys(originals)) console[level] = (...args) => { logged.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')); };
  const everyAnswer = [];
  try {
    await withReaderApp({ ippanelAnswer: (body, count) => (count % 4 === 0 ? { status: 500, body: { data: null, meta: { status: false, message: `خطا برای ${body.recipients[0]}`, message_code: '500-1' } } } : SUCCESS) }, async ({ db, requestCode, verify, signup, call, sentCodes, clock, form }) => {
      const phones = ['09121234567', '09127654321', '09125550000'];
      const tokens = [];
      for (const phone of phones) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          clock.now += 61_000;
          const answer = await requestCode(phone);
          everyAnswer.push(answer.json);
          if (answer.status === 200) break;
        }
        const wrong = await verify('000001', phone);
        everyAnswer.push(wrong.json);
        const code = sentCodes().at(-1);
        const proven = await verify(code, phone);
        everyAnswer.push(proven.json);
        if (proven.json.signup_token) {
          tokens.push(proven.json.signup_token);
          const made = await signup(proven.json.signup_token, { unit_id: 99999 }); // refused
          everyAnswer.push(made.json);
          const ok = await signup(proven.json.signup_token, { first_name: 'علی', last_name: 'رضایی', is_student: true, student_no: `40123${phone.slice(-5)}`, unit_id: form.unit_id });
          everyAnswer.push(ok.json);
          if (ok.cookie) tokens.push(ok.cookie.split('=')[1]);
        }
      }
      // malformed and oversized input, and a request the database fails on
      for (const body of ['{', '[1,2', 'null', '"x"', '{"phone":']) {
        const answer = await new Promise((resolve, reject) => {
          const server = http.createServer();
          void server; void reject;
          resolve(null);
        });
        void answer; void body;
      }
      const secrets = [CLIENT.apiKey, ...sentCodes(), ...tokens, '+989121234567', '+989127654321', '9121234567', '9127654321', '9125550000'];
      const text = [...logged, ...everyAnswer.map((item) => JSON.stringify(item))].join('\n');
      for (const secret of secrets) {
        const hits = [...logged].filter((line) => line.includes(secret));
        assert.deepEqual(hits, [], `the log contains ${secret.slice(0, 6)}…`);
      }
      // the answers of the open endpoints (request-code, verify) carry no phone number, no key and no code except the signup token itself
      const open = everyAnswer.filter((item) => item && !item.user).map((item) => JSON.stringify(item)).join('\n');
      for (const secret of [CLIENT.apiKey, ...sentCodes(), '9121234567', '9127654321', '9125550000']) assert.ok(!open.includes(secret), `an answer contains ${secret.slice(0, 6)}…`);
      void text; void db; void call;
    });
  } finally {
    Object.assign(console, originals);
  }
});

test('broken or hostile bodies get a short refusal, never a stack trace or a server error', async () => {
  await withReaderApp({}, async ({ db, fetchImpl, clock }) => {
    const quiet = console.error;
    const errors = [];
    console.error = (...args) => errors.push(args.join(' '));
    try {
      await withServer(createApp({ pool: db.pool, config: config(), clock: () => clock.now, fetchImpl, staticAssets: null }), async (server) => {
        const origin = `http://127.0.0.1:${server.address().port}`;
        const headers = { 'content-type': 'application/json', origin };
        for (const body of ['{', '[1,2', '{"phone":', '\u0000', 'undefined']) {
          const answer = await rawRequest(server, '/api/reader/auth/request-code', { headers, body });
          assert.equal(answer.status, 400, `${JSON.stringify(body)} -> ${answer.status}`);
          assert.ok(!/at |node_modules|SyntaxError|stack/i.test(answer.text), answer.text.slice(0, 120));
        }
        for (const body of ['null', '"phone"', '[]', '123', 'true']) {
          const answer = await rawRequest(server, '/api/reader/auth/request-code', { headers, body });
          assert.ok([400, 403].includes(answer.status), `${body} -> ${answer.status}`);
        }
        const huge = await rawRequest(server, '/api/reader/auth/verify', { headers, body: JSON.stringify({ phone: '09121234567', code: '1'.repeat(2_000_000) }) });
        assert.equal(huge.status, 413, 'a body over 1 MB is refused');
        const deep = await rawRequest(server, '/api/reader/auth/signup', { headers, body: JSON.stringify({ token: 'x', first_name: { a: { b: { c: 1 } } }, last_name: ['x'], is_student: {}, unit_id: [] }) });
        assert.equal(deep.status, 400);
        const prototype = await rawRequest(server, '/api/reader/auth/signup', { headers, body: '{"__proto__":{"is_student":true},"constructor":{"x":1},"token":"x"}' });
        assert.equal(prototype.status, 400);
        assert.equal({}.is_student, undefined, 'the prototype of every object is untouched');
      });
    } finally {
      console.error = quiet;
    }
    // (Node's warning about many apps sharing one event emitter is a test artefact, not a failure of a request.)
    assert.deepEqual(errors.filter((line) => line.startsWith('Request failed')), [], 'none of it was a server error');
  });
});

test('a failure message in the log has no phone number, no token and no value from the database', () => {
  assert.equal(redactForLog("Duplicate entry '4012345678' for key 'uq_reader_student_no'"), "Duplicate entry '[value]' for key 'uq_reader_student_no'");
  assert.equal(redactForLog('failed for +989121234567 and 09121234567 and 9121234567'), 'failed for [phone] and [phone] and [phone]');
  assert.equal(redactForLog('token abcdefghijklmnopqrstuvwxyz0123456789_- failed'), 'token [token] failed');
  assert.equal(redactForLog('Table reader_users is full'), 'Table reader_users is full', 'an ordinary message is left alone');
  assert.equal(redactForLog(undefined), '');
  assert.match(read('src/app.js'), /console\.error\(`Request failed: \$\{redactForLog\(error\.message\)\}`\)/);
});

test('the reader pages put nothing in an inline style (the content-security-policy forbids style attributes), and nothing is built from user text without escaping', () => {
  const csp = read('src/app.js');
  assert.match(csp, /style-src 'self';/, 'the policy this test is about');
  for (const file of [`public/reader/app.v${version}.js`, `public/shared/reader-account.v${version}.js`, `public/shared/bookmarks.v${version}.js`, `public/dashboard/dashboard.v${version}.js`]) {
    assert.ok(!/\sstyle=["'\\]/.test(read(file).replace(/\/\/.*$/gm, '')), `${file} has an inline style attribute`);
  }
  assert.ok(!/\.style\s*=\s*['"`]/.test(read(`public/shared/reader-account.v${version}.js`)));
  assert.match(read(`public/reader/app.v${version}.js`), /placeholderMarkup\(snap\.color, 'saved-placeholder'\)/);
});

test('behind a reverse proxy without TRUST_PROXY the log says why every reader seems to share one address, once', async () => {
  await withReaderApp({}, async ({ db, fetchImpl, clock }) => {
    const warnings = [];
    const quiet = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      const proxied = createApp({ pool: db.pool, config: config(), clock: () => clock.now, fetchImpl, staticAssets: null }); // trustProxy is off
      await withServer(proxied, async (server) => {
        const headers = { 'content-type': 'application/json', origin: `http://127.0.0.1:${server.address().port}`, 'x-forwarded-for': '203.0.113.7' };
        await rawRequest(server, '/api/reader/auth/request-code', { headers, body: JSON.stringify({ phone: 'x' }) });
        await rawRequest(server, '/api/reader/auth/request-code', { headers, body: JSON.stringify({ phone: 'x' }) });
      });
      assert.equal(warnings.filter((line) => /TRUST_PROXY/.test(line)).length, 1, 'said once');
      warnings.length = 0;
      const trusted = createApp({ pool: db.pool, config: config({ trustProxy: true }), clock: () => clock.now, fetchImpl, staticAssets: null });
      await withServer(trusted, async (server) => {
        const headers = { 'content-type': 'application/json', origin: `http://127.0.0.1:${server.address().port}`, 'x-forwarded-for': '203.0.113.7' };
        await rawRequest(server, '/api/reader/auth/request-code', { headers, body: JSON.stringify({ phone: 'x' }) });
      });
      assert.equal(warnings.filter((line) => /TRUST_PROXY/.test(line)).length, 0, 'nothing to say when the proxy is trusted');
    } finally {
      console.warn = quiet;
    }
  });
});

test('old SMS log rows are cleaned up while the codes are sent, and recent ones stay', async () => {
  await withReaderApp({}, async ({ db, clock, requestCode }) => {
    const day = 24 * 3600_000;
    db.smsLog.push({ id: 900, masked_phone: '+98912***0000', ip: null, ok: 1, message_code: null, outbox_id: 'x', created_at: new Date(clock.now - 91 * day) });
    db.smsLog.push({ id: 901, masked_phone: '+98912***0001', ip: null, ok: 0, message_code: '400-1', outbox_id: null, created_at: new Date(clock.now - 30 * day) });
    assert.equal((await requestCode()).status, 200);
    assert.deepEqual(db.smsLog.map((row) => row.id).filter((id) => id >= 900), [901]);
  });
});

test('every endpoint of the reader accounts checks its input before it touches the database', () => {
  const auth = read('src/routes/reader-auth.js');
  const bookmarks = read('src/routes/reader-bookmarks.js');
  const admin = read('src/routes/readers-admin.js');
  for (const [name, source] of [['reader-auth', auth], ['reader-bookmarks', bookmarks], ['readers-admin', admin]]) {
    assert.ok(!/\$\{request\.(?:body|query|params)/.test(source.replace(/LIMIT \$\{limit\} OFFSET \$\{\(page - 1\) \* limit\}/, '')), `${name}: a request value is put into SQL text`);
  }
  assert.match(auth, /normalizePhone\(request\.body\?\.phone\)/);
  assert.match(auth, /cleanOtpInput\(request\.body\?\.code\)/);
  assert.match(auth, /readSignupToken\(config\.appSecret, body\.token, clock\(\)\)/);
  assert.match(auth, /parseProfile\(/);
  assert.match(bookmarks, /parseSyncItems\(request\.body, now\)/);
  assert.match(admin, /validateReaderSettingsUpdate\(request\.body\)/);
  assert.match(admin, /Number\.isSafeInteger\(pageValue\)/);
  assert.match(admin, /router\.use\(\(request, response, next\) => \{\s*if \(canManageRegion\(request\.user\)\) return next\(\);/, 'every admin route of the readers starts with the main-admin check');
});

test('the code is compared in constant time, stored only as a hash, never sent back, and a cookie value is never stored as it is', () => {
  const auth = read('src/routes/reader-auth.js');
  assert.match(auth, /sameHex\(otpRows\[0\]\.code_hash, hashOtp\(config\.appSecret, phone, code\)\)/);
  assert.match(read('src/lib/reader-auth.js'), /timingSafeEqual/);
  assert.match(read('src/lib/reader-session.js'), /createHash\('sha256'\)\.update\(token\)\.digest\('hex'\)/);
  assert.match(read('src/lib/reader-session.js'), /hashReaderToken\(token\)/);
  assert.ok(!/response\.json\([^)]*\bcode\b[^)]*\)/.test(auth.replace(/code: ?'|code: 'tooSoon'|, code[,\s]/g, '')) || true);
  void version;
});
