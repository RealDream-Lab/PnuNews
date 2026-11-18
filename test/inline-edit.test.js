import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import express from 'express';
import { createAuthRouter } from '../src/routes/auth.js';
import { createNewsAdminRouter } from '../src/routes/news-admin.js';

const REGIONS = [
  { id: 1, parent_id: null, type: 'country', name: 'کشور', code: null, sort_order: 0 },
  { id: 10, parent_id: 1, type: 'province', name: 'اصفهان', code: null, sort_order: 1 },
  { id: 100, parent_id: 10, type: 'city', name: 'نجف‌آباد', code: null, sort_order: 2 },
  { id: 101, parent_id: 10, type: 'city', name: 'کاشان', code: null, sort_order: 3 },
  { id: 20, parent_id: 1, type: 'province', name: 'یزد', code: null, sort_order: 4 },
];
const USERS = {
  1: { id: 1, role: 'super_admin', region_id: 1 },
  2: { id: 2, role: 'country_admin', region_id: 1 },
  3: { id: 3, role: 'province_admin', region_id: 10 },
  4: { id: 4, role: 'city_admin', region_id: 100 },
  5: { id: 5, role: 'city_admin', region_id: 101 },
  6: { id: 6, role: 'domain_user', region_id: 100 },
  7: { id: 7, role: 'province_admin', region_id: 20 },
};
// News: 1 by the Najafabad admin, 2 by the Kashan admin, 3 by the Najafabad domain user, 4 by the Isfahan province admin,
// 5 the automatic portal news, 6 deleted (never returned by the query).
const NEWS = [
  { id: 1, created_by: 4, source_url: null, created_by_role: 'city_admin', created_by_region_id: 100 },
  { id: 2, created_by: 5, source_url: null, created_by_role: 'city_admin', created_by_region_id: 101 },
  { id: 3, created_by: 6, source_url: null, created_by_role: 'domain_user', created_by_region_id: 100 },
  { id: 4, created_by: 3, source_url: null, created_by_role: 'province_admin', created_by_region_id: 10 },
  { id: 5, created_by: 1, source_url: 'https://pnu.ac.ir/x', created_by_role: 'super_admin', created_by_region_id: 1 },
];

function pool() {
  const run = (sql, params = []) => {
    if (sql.startsWith('SELECT id, parent_id, type, name, code, sort_order FROM regions')) return REGIONS;
    if (sql.includes('FROM news n JOIN users creator')) return NEWS.filter((news) => params.includes(news.id));
    return [];
  };
  return { execute: async (sql, params) => [run(sql, params)], query: async (sql, params) => [run(sql, params)] };
}

async function editableFor(userId, ids) {
  const app = express();
  app.use((request, response, next) => { request.user = USERS[userId]; next(); });
  app.use('/api/admin/news', createNewsAdminRouter({ pool: pool(), uploadRoot: '/tmp' }));
  const server = app.listen(0);
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/news/editable?ids=${ids}`);
    return { status: response.status, body: await response.json() };
  } finally {
    server.close();
  }
}

test('the edit buttons follow the panel rule: own news, the unit\'s domain users, admins below, the portal feed for the top two', async () => {
  const all = '1,2,3,4,5,6,999';
  assert.deepEqual((await editableFor(1, all)).body.ids, [1, 2, 3, 4, 5], 'the main admin edits everything that exists');
  assert.deepEqual((await editableFor(2, all)).body.ids, [4, 5], 'the central PR: province admins\' news and the portal feed');
  assert.deepEqual((await editableFor(3, all)).body.ids, [1, 2, 4], 'a province admin: own news and the city admins of the province');
  assert.deepEqual((await editableFor(4, all)).body.ids, [1, 3], 'a city admin: own news and the domain users of the city');
  assert.deepEqual((await editableFor(5, all)).body.ids, [2], 'another city admin sees only their own news');
  assert.deepEqual((await editableFor(6, all)).body.ids, [3], 'a domain user: only their own news');
  assert.deepEqual((await editableFor(7, all)).body.ids, [], 'a province admin of another province edits nothing of Isfahan');
});

test('the editable check ignores bad ids and answers an empty list for nothing', async () => {
  assert.deepEqual((await editableFor(1, '')).body.ids, []);
  assert.deepEqual((await editableFor(1, 'abc,-1,0,1.5')).body.ids, []);
  assert.deepEqual((await editableFor(4, '1,1,1')).body.ids, [1], 'repeated ids count once');
});

async function viewer(cookie, rows) {
  const authPool = { execute: async () => [rows], query: async () => [rows] };
  const app = express();
  app.use('/api/auth', createAuthRouter({ pool: authPool, config: { nodeEnv: 'test', appSecret: 'test-secret' } }));
  const server = app.listen(0);
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/viewer`, { headers: cookie ? { cookie } : {} });
    return { status: response.status, body: await response.json() };
  } finally {
    server.close();
  }
}

test('/api/auth/viewer never answers 401: a visitor, a dead session and a pending password change are all just "nobody"', async () => {
  assert.deepEqual(await viewer(null, []), { status: 200, body: { user: null } });
  assert.deepEqual(await viewer('pnu_session=dead', []), { status: 200, body: { user: null } });
  const row = { id: 4, username: 'u', full_name: 'مدیر', role: 'city_admin', region_id: 100, is_active: 1, must_change_password: 0, remember: 0, renew_due: 0 };
  assert.deepEqual(await viewer('pnu_session=ok', [row]), { status: 200, body: { user: { id: 4, full_name: 'مدیر', role: 'city_admin' } } });
  assert.deepEqual(await viewer('pnu_session=ok', [{ ...row, must_change_password: 1 }]), { status: 200, body: { user: null } });
});

test('the reader loads the editor module only on demand and marks the article for it', async () => {
  const version = JSON.parse(await readFile('package.json', 'utf8')).version;
  const reader = await readFile(`public/reader/app.v${version}.js`, 'utf8');
  assert.ok(reader.includes(`import('/shared/inline-edit.v${version}.js')`), 'dynamic import, not a static one every visitor pays for');
  assert.ok(!new RegExp(`^import .*inline-edit`, 'm').test(reader));
  assert.ok(reader.includes('data-news-page-id'));
  const editor = await readFile(`public/shared/inline-edit.v${version}.js`, 'utf8');
  assert.ok(editor.includes(`/shared/rich-editor.v${version}.js`));
  assert.ok(editor.includes('/api/admin/news/editable'));
});
