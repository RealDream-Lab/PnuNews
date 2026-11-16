import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { createNewsAdminRouter } from '../src/routes/news-admin.js';

const REGIONS = [
  { id: 1, parent_id: null, type: 'country', name: 'کشور', code: null, sort_order: 0 },
  { id: 10, parent_id: 1, type: 'province', name: 'اصفهان', code: null, sort_order: 1 },
  { id: 100, parent_id: 10, type: 'city', name: 'نجف‌آباد', code: null, sort_order: 2 },
];
const USERS = {
  1: { id: 1, full_name: 'مدیر ارشد', role: 'super_admin', region_id: 1, region_type: 'country', is_active: 1, is_system: 0 },
  2: { id: 2, full_name: 'روابط عمومی', role: 'country_admin', region_id: 1, region_type: 'country', is_active: 1, is_system: 0 },
  3: { id: 3, full_name: 'مدیر اصفهان', role: 'province_admin', region_id: 10, region_type: 'province', is_active: 1, is_system: 0 },
  4: { id: 4, full_name: 'مدیر نجف‌آباد', role: 'city_admin', region_id: 100, region_type: 'city', is_active: 1, is_system: 0 },
  5: { id: 5, full_name: 'مدیر غیرفعال', role: 'province_admin', region_id: 10, region_type: 'province', is_active: 0, is_system: 0 },
};

// A pool that holds one news (id 7, written by the city admin) and records what the assignment writes.
function fakePool(newsOverrides = {}) {
  const log = [];
  const news = { id: 7, created_by: 4, origin_region_id: 100, source_url: null, status: 'published', created_by_role: 'city_admin', created_by_name: 'مدیر نجف‌آباد', created_by_region_id: 100, created_by_is_active: 1, ...newsOverrides };
  const answer = (sql, params = []) => {
    if (sql.includes('FROM news n') && sql.includes('JOIN users creator')) return [news];
    if (sql.startsWith('SELECT id, parent_id, type, name, code, sort_order FROM regions')) return REGIONS;
    if (sql.includes('FROM users u JOIN regions r ON r.id = u.region_id WHERE u.id = ?')) return USERS[params[0]] ? [USERS[params[0]]] : [];
    if (sql.includes("u.is_active = 1 AND u.is_system = 0 AND u.role <> 'super_admin'")) {
      return Object.values(USERS).filter((user) => user.is_active && user.role !== 'super_admin' && ['country', 'province'].includes(user.region_type)).map((user) => ({ ...user, username: `u${user.id}`, region_name: REGIONS.find((region) => region.id === user.region_id).name, domain_name: null }));
    }
    log.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    return [];
  };
  const connection = { beginTransaction: async () => {}, commit: async () => { log.push({ sql: 'COMMIT' }); }, rollback: async () => { log.push({ sql: 'ROLLBACK' }); }, release() {}, execute: async (sql, params) => [answer(sql, params)] };
  return { log, execute: async (sql, params) => [answer(sql, params)], query: async (sql, params) => [answer(sql, params)], getConnection: async () => connection };
}

async function withServer(pool, user, task) {
  const app = express();
  app.use(express.json());
  app.use((request, response, next) => { request.user = user; next(); });
  app.use('/api/admin/news', createNewsAdminRouter({ pool, uploadRoot: '/tmp' }));
  const server = app.listen(0);
  await once(server, 'listening');
  try {
    const call = async (path, body) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/news${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    return await task(call);
  } finally {
    server.close();
  }
}

test('the assignee list is the active country- and province-level users, for the main admin only', async () => {
  const listed = await withServer(fakePool(), USERS[1], (call) => call('/assignees'));
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.users.map((user) => user.id), [2, 3], 'not the city admin, the inactive admin or the main admin');
  for (const id of [2, 3, 4]) assert.equal((await withServer(fakePool(), USERS[id], (call) => call('/assignees'))).status, 403);
});

test('the main admin hands a news to a province admin: owner and origin change, in one audited transaction', async () => {
  const pool = fakePool();
  const result = await withServer(pool, USERS[1], (call) => call('/7/assign', { user_id: 3 }));
  assert.equal(result.status, 200);
  assert.equal(result.body.user_id, 3);
  const update = pool.log.find((entry) => entry.sql.startsWith('UPDATE news SET created_by'));
  assert.deepEqual(update.params, [3, 10, 1, 7], 'owner, the new owner\'s unit as origin, who did it, which news');
  const audit = pool.log.find((entry) => entry.sql.includes('INSERT INTO audit_log'));
  assert.equal(audit.params[1], 'news.assign');
  assert.deepEqual(JSON.parse(audit.params[3]), { from_user_id: 4, to_user_id: 3, from_region_id: 100, to_region_id: 10 });
  assert.equal(pool.log.at(-1).sql, 'COMMIT');
});

test('a published news also gets the new author\'s name and unit as its publisher line', async () => {
  const pool = fakePool({ published_by_user_id: 4, publisher_name: 'مدیر نجف‌آباد', publisher_unit: 'دانشگاه پیام نور نجف‌آباد' });
  const result = await withServer(pool, USERS[1], (call) => call('/7/assign', { user_id: 3 }));
  assert.equal(result.status, 200);
  const update = pool.log.find((entry) => entry.sql.startsWith('UPDATE news SET created_by'));
  assert.ok(update.sql.includes('publisher_name = ?') && update.sql.includes('publisher_unit = ?'));
  assert.deepEqual(update.params, [3, 10, 3, 'مدیر اصفهان', 'دانشگاه پیام نور استان اصفهان', 1, 7]);
  const toCountry = fakePool({ published_by_user_id: 4, publisher_name: 'x', publisher_unit: 'y' });
  await withServer(toCountry, USERS[1], (call) => call('/7/assign', { user_id: 2 }));
  assert.deepEqual(toCountry.log.find((entry) => entry.sql.startsWith('UPDATE news SET created_by')).params, [2, 1, 2, 'روابط عمومی', 'روابط عمومی سازمان مرکزی', 1, 7]);
});

test('a news is handed only to an active country- or province-level user, never twice to the same one', async () => {
  for (const [userId, status] of [[4, 400], [5, 400], [1, 400], [99, 400]]) {
    const pool = fakePool({ created_by: 2, origin_region_id: 1, created_by_role: 'country_admin', created_by_region_id: 1 });
    const result = await withServer(pool, USERS[1], (call) => call('/7/assign', { user_id: userId }));
    assert.equal(result.status, status, `user ${userId}`);
    assert.ok(!pool.log.some((entry) => entry.sql.startsWith('UPDATE news')), `user ${userId}: nothing is written`);
  }
  const same = await withServer(fakePool({ created_by: 3, origin_region_id: 10 }), USERS[1], (call) => call('/7/assign', { user_id: 3 }));
  assert.equal(same.status, 409);
});

test('nobody but the main admin can assign, and the portal feed cannot be assigned', async () => {
  for (const id of [2, 3, 4]) {
    const pool = fakePool({ created_by: id, created_by_role: USERS[id].role, created_by_region_id: USERS[id].region_id });
    const result = await withServer(pool, USERS[id], (call) => call('/7/assign', { user_id: 3 }));
    assert.equal(result.status, 403, `role of user ${id}`);
    assert.ok(!pool.log.some((entry) => entry.sql.startsWith('UPDATE news SET created_by')));
  }
  const portal = await withServer(fakePool({ source_url: 'https://pnu.ac.ir/x' }), USERS[1], (call) => call('/7/assign', { user_id: 3 }));
  assert.equal(portal.status, 403);
});

test('the editor offers the assignment to the main admin only, and not on portal news', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const dir = new URL('../public/dashboard/', import.meta.url);
  const script = await readFile(new URL((await readdir(dir)).find((name) => /^dashboard\.v[\d.]+\.js$/.test(name)), dir), 'utf8');
  const html = await readFile(new URL('index.html', dir), 'utf8');
  assert.match(html, /id="editor-assign"/);
  assert.match(script, /assign\.hidden = !\(state\.user\.role === "super_admin" && !item\.source_url\)/);
  assert.match(script, /api\("\/api\/admin\/news\/assignees"\)/);
  assert.match(script, /\/api\/admin\/news\/\$\{id\}\/assign/);
  assert.match(script, /select: \{ placeholder: "انتخاب کاربر…", options \}/);
  assert.match(script, /"news\.assign": "اختصاص خبر به کاربر دیگر"/);
  assert.match(script, /if \(isSelect && !field\.value\) field\.focus\(\)/, 'a list without a choice does not confirm');
});
