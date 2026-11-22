import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { createReaderAdminRouter } from '../src/routes/readers-admin.js';

// A pool that records the SQL of the readers list and answers from a few rows.
function fakePool({ rows = [], total = rows.length, readers = 40, students = 12 } = {}) {
  const calls = [];
  return {
    calls,
    execute: async (sql, params) => {
      const text = sql.replace(/\s+/g, ' ').trim();
      calls.push({ sql: text, params });
      if (/^SELECT COUNT\(\*\) AS total FROM reader_users u/.test(text)) return [[{ total }], []];
      if (/^SELECT COUNT\(\*\) AS readers, COALESCE\(SUM\(is_student\), 0\) AS students FROM reader_users$/.test(text)) return [[{ readers, students }], []];
      if (/^SELECT u\.id, u\.phone/.test(text)) return [rows, []];
      throw new Error(`unhandled: ${text}`);
    },
    query: async () => [[], []],
  };
}

async function withRouter(pool, role, run) {
  const app = express();
  app.use((request, response, next) => { request.user = role ? { id: 1, role } : undefined; next(); });
  app.use('/api/admin/readers', createReaderAdminRouter({ pool, events: new EventEmitter() }));
  app.use((error, request, response, next) => response.status(500).json({ error: 'x' }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const get = (path) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null }));
    }).on('error', reject);
  });
  try { return await run(get); } finally { server.close(); server.closeAllConnections?.(); }
}

const row = (overrides = {}) => ({
  id: 7, phone: '+989121234567', first_name: 'علی', last_name: 'رضایی', is_student: 1, student_no: '4012345678', unit_id: 51,
  created_at: new Date('2026-11-20T08:00:00Z'), last_login_at: new Date('2026-11-21T09:30:00Z'), unit_name: 'بیجار', province_name: 'کردستان', ...overrides,
});

test('only the main admin can see the readers', async () => {
  for (const role of ['country_admin', 'province_admin', 'city_admin', 'domain_user', undefined]) {
    const pool = fakePool();
    await withRouter(pool, role, async (get) => {
      assert.equal((await get('/api/admin/readers/users')).status, 403, String(role));
    });
    assert.equal(pool.calls.length, 0, 'nothing is read for anyone else');
  }
});

test('the list: newest first, the center and province by name, the student number marked as declared, pages and totals', async () => {
  const pool = fakePool({ rows: [row(), row({ id: 6, student_no: null, is_student: 0, unit_id: null, unit_name: null, province_name: null, last_login_at: null })], total: 53 });
  await withRouter(pool, 'super_admin', async (get) => {
    const answer = await get('/api/admin/readers/users');
    assert.equal(answer.status, 200);
    assert.deepEqual([answer.json.page, answer.json.pages, answer.json.total, answer.json.limit], [1, 3, 53, 25]);
    assert.deepEqual(answer.json.totals, { readers: 40, students: 12 });
    assert.deepEqual(answer.json.items[0], {
      id: 7, first_name: 'علی', last_name: 'رضایی', phone: '+989121234567', is_student: true, student_no: '4012345678',
      unit: { id: 51, name: 'بیجار', province: 'کردستان' }, created_at: '2026-11-20T08:00:00.000Z', last_login_at: '2026-11-21T09:30:00.000Z',
    });
    assert.equal(answer.json.items[1].unit, null);
    assert.equal(answer.json.items[1].student_no, null);
    assert.equal(answer.json.items[1].last_login_at, null);
    const list = pool.calls.find((call) => call.sql.startsWith('SELECT u.id'));
    assert.match(list.sql, /ORDER BY u\.created_at DESC, u\.id DESC LIMIT 25 OFFSET 0$/);
    assert.match(list.sql, /LEFT JOIN regions c ON c\.id = u\.unit_id LEFT JOIN regions p ON p\.id = c\.parent_id/);
    assert.deepEqual(list.params, []);
    const third = await get('/api/admin/readers/users?page=3&limit=20');
    assert.deepEqual([third.json.page, third.json.pages, third.json.limit], [3, 3, 20]);
    assert.match(pool.calls.filter((call) => call.sql.startsWith('SELECT u.id')).at(-1).sql, /LIMIT 20 OFFSET 40$/);
    assert.equal((await get('/api/admin/readers/users?page=99')).json.page, 3, 'a page past the end is the last page');
    assert.equal((await get('/api/admin/readers/users?limit=5000')).json.limit, 100, 'the page size is capped');
    assert.equal((await get('/api/admin/readers/users?limit=abc')).json.limit, 25);
  });
});

test('the list refuses a page that is not a number, and nothing is read', async () => {
  const pool = fakePool();
  await withRouter(pool, 'super_admin', async (get) => {
    for (const page of ['0', '-1', 'x', '1.5', '100001']) assert.equal((await get(`/api/admin/readers/users?page=${page}`)).status, 400, page);
  });
  assert.equal(pool.calls.length, 0);
});

test('the search: every word must be found in the names, the student number or the phone; digits may be Persian; wildcards are plain characters', async () => {
  const pool = fakePool({ rows: [row()] });
  await withRouter(pool, 'super_admin', async (get) => {
    const encode = encodeURIComponent;
    const lastList = () => pool.calls.filter((call) => call.sql.startsWith('SELECT u.id')).at(-1);

    await get(`/api/admin/readers/users?q=${encode('علی رضایی')}`);
    assert.equal((lastList().sql.match(/\(u\.first_name LIKE \? OR u\.last_name LIKE \? OR u\.student_no LIKE \?\)/g) ?? []).length, 2, 'one group per word, joined by AND');
    assert.match(lastList().sql, /WHERE \(.*\) AND \(.*\) ORDER BY/);
    assert.deepEqual(lastList().params, ['%علی%', '%علی%', '%علی%', '%رضایی%', '%رضایی%', '%رضایی%']);

    await get(`/api/admin/readers/users?q=${encode('۰۹۱۲۳۴۵')}`);
    assert.match(lastList().sql, /u\.phone LIKE \?/);
    assert.deepEqual(lastList().params, ['%0912345%', '%0912345%', '%0912345%', '%91234 5%'.replace(' ', '')], 'the number is looked for without its leading zero, and Persian digits are converted');

    await get(`/api/admin/readers/users?q=${encode('09')}`);
    assert.ok(!/u\.phone LIKE/.test(lastList().sql), 'two digits are too short to look for in a number');

    await get(`/api/admin/readers/users?q=${encode('ab123')}`);
    assert.ok(!/u\.phone LIKE/.test(lastList().sql), 'a word with letters in it is not a phone number');
    await get(`/api/admin/readers/users?q=${encode('100%_\\')}`);
    assert.deepEqual(lastList().params.slice(0, 3), ['%100\\%\\_\\\\%', '%100\\%\\_\\\\%', '%100\\%\\_\\\\%'], 'a % or _ typed by the admin is searched for, not a wildcard');

    await get(`/api/admin/readers/users?q=${encode('كريمي')}`);
    assert.equal(lastList().params[0], '%کریمی%', 'Arabic letter forms match the stored Persian ones');

    await get(`/api/admin/readers/users?q=${encode('a b c d e f g')}`);
    assert.equal(lastList().params.length, 12, 'at most four words');
    await get(`/api/admin/readers/users?q=${encode('x'.repeat(500))}`);
    assert.equal(lastList().params[0].length, 80 + 2, 'and at most 80 characters');
    await get('/api/admin/readers/users?q=');
    assert.ok(!/WHERE/.test(lastList().sql), 'an empty search is the whole list');
    await get('/api/admin/readers/users?q=a&q=b');
    assert.ok(!/WHERE/.test(lastList().sql), 'something other than text is ignored');
    const counted = pool.calls.filter((call) => call.sql.startsWith('SELECT COUNT(*) AS total')).at(-1);
    assert.deepEqual(counted.params, [], 'the total follows the same search (here none)');
  });
});

test('the count uses the same search as the list, and no value is ever put into the SQL text', async () => {
  const pool = fakePool({ rows: [row()], total: 1 });
  await withRouter(pool, 'super_admin', async (get) => {
    await get(`/api/admin/readers/users?q=${encodeURIComponent("'; DROP TABLE reader_users; --")}`);
  });
  const [counted, listed] = [pool.calls.find((c) => c.sql.startsWith('SELECT COUNT(*) AS total')), pool.calls.find((c) => c.sql.startsWith('SELECT u.id'))];
  assert.deepEqual(counted.params, listed.params);
  for (const call of pool.calls) assert.ok(!/DROP|--/.test(call.sql), call.sql);
  assert.ok(listed.params.includes('%DROP%'), 'what was typed is a parameter, not SQL');
});
