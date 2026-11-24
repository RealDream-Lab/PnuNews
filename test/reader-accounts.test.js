import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createApp } from '../src/app.js';
import { migrate } from '../scripts/migrate.js';
import { READER_SETTING_DEFAULTS, READER_SETTING_KEYS, readerSettingsFromRows, validateReaderSettingsUpdate } from '../src/lib/reader-settings.js';
import { createPublicRouter } from '../src/routes/public.js';
import { createReaderAdminRouter } from '../src/routes/readers-admin.js';

const root = new URL('../', import.meta.url);
const read = (relative) => readFile(fileURLToPath(new URL(relative, root)), 'utf8');

function request(server, path, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, path, method,
      headers: body ? { 'content-type': 'application/json', origin: `http://127.0.0.1:${server.address().port}` } : {},
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

async function withServer(app, run) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(server);
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
}

// A settings table in memory behind the two ways the routes talk to the database.
function fakeDatabase(initial = {}, { failOnExecute = false } = {}) {
  const settings = new Map(Object.entries(initial));
  const log = { executes: [], began: 0, committed: 0, rolledBack: 0, released: 0 };
  const connection = {
    beginTransaction: async () => { log.began += 1; },
    commit: async () => { log.committed += 1; },
    rollback: async () => { log.rolledBack += 1; },
    release: () => { log.released += 1; },
    execute: async (sql, params) => {
      if (failOnExecute) throw new Error('disk full');
      log.executes.push({ sql, params });
      if (/INSERT INTO settings/.test(sql)) settings.set(params[0], params[1]);
      return [{}, []];
    },
  };
  const pool = {
    query: async (sql) => {
      if (/FROM settings/.test(sql)) return [[...settings].map(([k, v]) => ({ k, v })), []];
      return [[], []]; // regions and everything else: nothing
    },
    getConnection: async () => connection,
  };
  return { pool, settings, log };
}

const asUser = (user) => (req, res, next) => { req.user = user; next(); };
const SUPER = { id: 1, role: 'super_admin' };

function readersApp({ user, database, events = new EventEmitter() }) {
  const app = express();
  app.use(express.json());
  app.use(asUser(user));
  app.use('/api/admin/readers', createReaderAdminRouter({ pool: database.pool, events }));
  return { app, events };
}

test('reader settings: a table without rows gives the defaults, damaged rows fall back to them', () => {
  assert.deepEqual(readerSettingsFromRows([]), { signup_enabled: false, auth_method: 'sms_send', inbound_line: '', inbound_ips: [], sms_cost_rial: 2000, sms_min_remaining: 200, sms_daily_cap: 300 });
  const damaged = readerSettingsFromRows([
    { k: 'reader_signup_enabled', v: '1' }, { k: 'sms_cost_rial', v: 'abc' }, { k: 'sms_min_remaining', v: '-5' }, { k: 'sms_daily_cap', v: '999999999' },
  ]);
  assert.deepEqual(damaged, { signup_enabled: true, auth_method: 'sms_send', inbound_line: '', inbound_ips: [], sms_cost_rial: 2000, sms_min_remaining: 200, sms_daily_cap: 300 });
  assert.equal(readerSettingsFromRows([{ k: 'reader_signup_enabled', v: 'true' }]).signup_enabled, false, 'only 1 means on');
  assert.equal(READER_SETTING_DEFAULTS.reader_signup_enabled, '0', 'signup is off until the main admin turns it on');
  assert.deepEqual([...READER_SETTING_KEYS].sort(), ['reader_auth_method', 'reader_inbound_ips', 'reader_inbound_line', 'reader_signup_enabled', 'sms_cost_rial', 'sms_daily_cap', 'sms_min_remaining']);
});

test('reader settings: updates are validated strictly', () => {
  assert.deepEqual(validateReaderSettingsUpdate({ signup_enabled: true, sms_cost_rial: 2000 }), { ok: true, values: { signup_enabled: true, sms_cost_rial: 2000 } });
  for (const bad of [null, undefined, [], 'x', 5, {}, { unknown: 1 }, { signup_enabled: 1 }, { signup_enabled: 'true' }, { sms_cost_rial: '2000' },
    { sms_cost_rial: 99 }, { sms_cost_rial: 100_001 }, { sms_cost_rial: 2000.5 }, { sms_daily_cap: 0 }, { sms_min_remaining: -1 }, { sms_min_remaining: Number.NaN },
    { signup_enabled: true, __proto__x: 1 }, { constructor: 1 }]) {
    assert.equal(validateReaderSettingsUpdate(bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(validateReaderSettingsUpdate({ sms_min_remaining: 0 }).ok, true, 'zero is a valid minimum');
  assert.match(validateReaderSettingsUpdate({ sms_cost_rial: 5 }).error, /هزینهٔ هر پیامک/);
});

test('only the main admin can read or change the reader settings', async () => {
  for (const role of ['country_admin', 'province_admin', 'city_admin', 'domain_user']) {
    const database = fakeDatabase();
    const { app } = readersApp({ user: { id: 2, role }, database });
    await withServer(app, async (server) => {
      assert.equal((await request(server, '/api/admin/readers/settings')).status, 403, role);
      assert.equal((await request(server, '/api/admin/readers/settings', { method: 'PUT', body: { signup_enabled: true } })).status, 403, role);
    });
    assert.equal(database.log.executes.length, 0, 'nothing was written');
    assert.equal(database.settings.size, 0);
  }
  const { app } = readersApp({ user: undefined, database: fakeDatabase() });
  await withServer(app, async (server) => {
    assert.equal((await request(server, '/api/admin/readers/settings')).status, 403, 'no user at all');
  });
});

test('the main admin reads the settings and switches signup on: written, audited, and the site is told', async () => {
  const database = fakeDatabase();
  const { app, events } = readersApp({ user: SUPER, database });
  const heard = [];
  events.on('settings.changed', () => heard.push('changed'));
  await withServer(app, async (server) => {
    const before = await request(server, '/api/admin/readers/settings');
    assert.equal(before.status, 200);
    assert.deepEqual(before.json.settings, { signup_enabled: false, auth_method: 'sms_send', inbound_line: '', inbound_ips: [], sms_cost_rial: 2000, sms_min_remaining: 200, sms_daily_cap: 300 });

    const put = await request(server, '/api/admin/readers/settings', { method: 'PUT', body: { signup_enabled: true, sms_daily_cap: 500, sms_cost_rial: 2000 } });
    assert.equal(put.status, 200);
    assert.deepEqual(put.json.settings, { signup_enabled: true, auth_method: 'sms_send', inbound_line: '', inbound_ips: [], sms_cost_rial: 2000, sms_min_remaining: 200, sms_daily_cap: 500 });
  });
  assert.equal(database.settings.get('reader_signup_enabled'), '1');
  assert.equal(database.settings.get('sms_daily_cap'), '500');
  assert.equal(database.settings.has('sms_cost_rial'), false, 'an unchanged value is not rewritten');
  assert.deepEqual([database.log.began, database.log.committed, database.log.rolledBack, database.log.released], [1, 1, 0, 1]);
  const audit = database.log.executes.find((call) => /INSERT INTO audit_log/.test(call.sql));
  assert.ok(audit, 'the change is in the audit log');
  assert.equal(audit.params[0], 1);
  assert.equal(audit.params[1], 'reader.settings.update');
  assert.deepEqual(JSON.parse(audit.params[2]), { changed: { signup_enabled: { from: false, to: true }, sms_daily_cap: { from: 300, to: 500 } } });
  assert.deepEqual(heard, ['changed']);
});

test('saving the values that are already stored writes nothing and tells nobody', async () => {
  const database = fakeDatabase({ reader_signup_enabled: '1' });
  const { app, events } = readersApp({ user: SUPER, database });
  let heard = 0;
  events.on('settings.changed', () => { heard += 1; });
  await withServer(app, async (server) => {
    const put = await request(server, '/api/admin/readers/settings', { method: 'PUT', body: { signup_enabled: true } });
    assert.equal(put.status, 200);
    assert.equal(put.json.settings.signup_enabled, true);
  });
  assert.equal(database.log.began, 0);
  assert.equal(heard, 0);
});

test('invalid settings are refused before the database is touched, and a failed write is rolled back', async () => {
  const database = fakeDatabase();
  const { app, events } = readersApp({ user: SUPER, database });
  let heard = 0;
  events.on('settings.changed', () => { heard += 1; });
  await withServer(app, async (server) => {
    for (const body of [{ signup_enabled: 'yes' }, { sms_cost_rial: 1 }, { hacker: true }, {}]) {
      const response = await request(server, '/api/admin/readers/settings', { method: 'PUT', body });
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.ok(response.json.error);
    }
  });
  assert.equal(database.log.began, 0);

  const failing = fakeDatabase({}, { failOnExecute: true });
  const failingApp = readersApp({ user: SUPER, database: failing });
  failingApp.app.use((error, req, res, next) => res.status(500).json({ error: 'x' })); // the app's own error handler
  failingApp.events.on('settings.changed', () => { heard += 1; });
  await withServer(failingApp.app, async (server) => {
    const response = await request(server, '/api/admin/readers/settings', { method: 'PUT', body: { signup_enabled: true } });
    assert.equal(response.status, 500);
  });
  assert.deepEqual([failing.log.began, failing.log.committed, failing.log.rolledBack, failing.log.released], [1, 0, 1, 1]);
  assert.equal(failing.settings.size, 0);
  assert.equal(heard, 0);
});

test('behind the real admin login: no session means 401, and the route is mounted after the authentication', async () => {
  const config = { publicUrl: 'https://news.example.ir', nodeEnv: 'production', trustProxy: false, appSecret: 'x'.repeat(64), uploadDir: '/tmp/u' };
  const app = createApp({ pool: {}, config, staticAssets: null });
  await withServer(app, async (server) => {
    const response = await request(server, '/api/admin/readers/settings');
    assert.equal(response.status, 401);
    assert.equal(response.headers['cache-control'], 'no-store');
  });
  const admin = await read('src/routes/admin.js');
  const auth = admin.indexOf('router.use(createAuthMiddleware(pool, config), requirePasswordChanged)');
  const mount = admin.indexOf("router.use('/readers', createReaderAdminRouter({ pool, config, smsBudget }))");
  assert.ok(auth > -1 && mount > auth, 'every reader route sits behind the admin authentication');
});

test('the public config tells the reader whether signup is on, and follows a change at once', async () => {
  const database = fakeDatabase();
  const events = new EventEmitter();
  const app = express();
  app.use(createPublicRouter({ pool: database.pool, config: { publicUrl: 'https://news.example.ir' }, events, staticAssets: null }));
  await withServer(app, async (server) => {
    const off = await request(server, '/api/public/config');
    assert.equal(off.status, 200);
    assert.deepEqual(off.json.reader, { signup_enabled: false, auth_method: 'sms_send' });
    assert.equal(off.json.site_title, 'اخبار پیام نور', 'the rest of the config is unchanged');
    assert.ok('radio' in off.json && 'provinces' in off.json);

    database.settings.set('reader_signup_enabled', '1');
    assert.equal((await request(server, '/api/public/config')).json.reader.signup_enabled, false, 'still the cached answer for a few seconds');
    events.emit('settings.changed');
    assert.equal((await request(server, '/api/public/config')).json.reader.signup_enabled, true, 'the switch reaches readers right after the change');
  });
});

test('migration: the five reader tables are created idempotently, and the migration runner applies them once', async () => {
  const sql = await read('migrations/2026112001_reader_accounts.sql');
  const statements = sql.replace(/^\s*--.*$/gm, '').split(';').map((part) => part.trim()).filter(Boolean);
  assert.equal(statements.length, 5);
  assert.deepEqual(statements.map((statement) => /^CREATE TABLE IF NOT EXISTS (\w+)/.exec(statement)?.[1]),
    ['reader_users', 'reader_sessions', 'reader_otps', 'reader_bookmarks', 'sms_log']);
  assert.match(sql, /UNIQUE KEY uq_reader_phone \(phone\)/);
  assert.match(sql, /UNIQUE KEY uq_reader_student_no \(student_no\)/);
  assert.match(sql, /student_no VARCHAR\(20\) NULL/, 'many readers without a student number are allowed');
  assert.match(sql, /PRIMARY KEY \(user_id, news_id\)/);
  assert.match(sql, /FOREIGN KEY \(news_id\) REFERENCES news\(id\) ON DELETE CASCADE/, 'a bookmark disappears with its news');
  assert.match(sql, /FOREIGN KEY \(user_id\) REFERENCES reader_users\(id\) ON DELETE CASCADE/);
  assert.match(sql, /FOREIGN KEY \(unit_id\) REFERENCES regions\(id\) ON DELETE SET NULL/);
  assert.ok(!/\bphone_plain|\bcode\b VARCHAR|otp_code\b/.test(sql), 'a code is never stored in clear text');
  assert.match(sql, /code_hash CHAR\(64\)/);
  assert.ok(!/INSERT\s/i.test(sql), 'settings fall back to defaults in code, so no rows are inserted');

  const applied = new Set();
  const executed = [];
  const connection = {
    query: async (text, params) => {
      if (/SELECT version FROM schema_migrations/.test(text)) return [[...applied].map((version) => ({ version })), []];
      if (/GET_LOCK/.test(text)) return [[{ acquired: 1 }], []];
      if (/INSERT INTO schema_migrations/.test(text)) { applied.add(params[0]); return [{}, []]; }
      executed.push(text);
      return [[], []];
    },
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {},
  };
  const pool = { getConnection: async () => connection };
  const quiet = console.info;
  console.info = () => {};
  try {
    await migrate(pool);
    const firstRun = executed.filter((text) => /reader_|sms_log/.test(text)).length;
    assert.equal(firstRun, 7, 'five tables of the accounts and the two of the inbound-SMS method');
    assert.ok(applied.has('2026112001_reader_accounts.sql'));
    assert.ok(applied.has('2026112401_reader_inbound_sms.sql'));
    executed.length = 0;
    await migrate(pool);
    assert.equal(executed.filter((text) => /CREATE TABLE/.test(text) && !/schema_migrations/.test(text)).length, 0, 'the second run changes nothing');
  } finally {
    console.info = quiet;
  }
});
