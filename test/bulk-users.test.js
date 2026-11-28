import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { bulkSetActive } from '../src/lib/bulk-users.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(`${root}${path}`, 'utf8');
const version = JSON.parse(read('package.json')).version;

// A connection that answers the candidate query from `users` the way MariaDB would (active flag, system flag, role, the actor) and records writes.
function fakeConnection(users) {
  const writes = [];
  return {
    writes,
    execute: async (sql, params) => {
      const text = sql.replace(/\s+/g, ' ').trim();
      if (text.startsWith('SELECT id, role, region_id, domain_id FROM users')) {
        const [active, actorId] = params;
        assert.match(text, /is_system = 0 AND role <> 'super_admin' AND id <> \?/);
        return [users.filter((user) => Number(user.is_active) === active && !user.is_system && user.role !== 'super_admin' && user.id !== actorId), []];
      }
      writes.push({ text, params });
      return [{}, []];
    },
  };
}

const USERS = [
  { id: 1, role: 'super_admin', is_active: 1, is_system: 0 },
  { id: 2, role: 'province_admin', is_active: 1, is_system: 0, region_id: 10 },
  { id: 3, role: 'city_admin', is_active: 1, is_system: 0, region_id: 11 },
  { id: 4, role: 'super_admin', is_active: 1, is_system: 1 }, // the portal robot
  { id: 5, role: 'domain_user', is_active: 1, is_system: 0, region_id: 11, domain_id: 2 },
];

test('switching everyone off spares the main admins, the robot and the person asking; sessions end', async () => {
  const connection = fakeConnection(USERS);
  const result = await bulkSetActive(connection, { actorId: 1, wanted: false, findConflict: async () => null });
  assert.deepEqual(result, { changed: 3, skipped: 0 });
  const off = connection.writes.filter((write) => write.text.startsWith('UPDATE users SET is_active = 0')).map((write) => write.params[0]);
  assert.deepEqual(off.sort(), [2, 3, 5]);
  const sessions = connection.writes.filter((write) => write.text.startsWith('DELETE FROM sessions')).map((write) => write.params[0]);
  assert.deepEqual(sessions.sort(), [2, 3, 5]);
  assert.equal(connection.writes.filter((write) => write.text.startsWith('DELETE s FROM reader_sessions')).length, 3, 'the linked reader sessions end too');
});

test('switching everyone on skips the users that would break the one-active-per-unit rule', async () => {
  const inactive = [
    { id: 20, role: 'city_admin', is_active: 0, is_system: 0, region_id: 11 },
    { id: 21, role: 'city_admin', is_active: 0, is_system: 0, region_id: 11 },
    { id: 22, role: 'domain_user', is_active: 0, is_system: 0, region_id: 11, domain_id: 2 },
  ];
  const connection = fakeConnection(inactive);
  const activated = new Set();
  // The unit's rule: one admin per region. The first one tried (the most recent login) wins.
  const findConflict = async (_connection, target) => (target.role === 'city_admin' && [...activated].some((id) => inactive.find((u) => u.id === id).region_id === target.region_id) ? 'conflict' : null);
  const originalExecute = connection.execute;
  connection.execute = async (sql, params) => {
    if (/^UPDATE users SET is_active = 1/.test(sql)) activated.add(params[0]);
    return originalExecute(sql, params);
  };
  const result = await bulkSetActive(connection, { actorId: 1, wanted: true, findConflict });
  assert.deepEqual(result, { changed: 2, skipped: 1 });
  assert.deepEqual([...activated].sort(), [20, 22]);
});

test('the route is main-admin-only and audited; the page offers both buttons to the main admin only', () => {
  const route = read('src/routes/admin.js');
  assert.match(route, /router\.post\('\/users\/bulk-active', async \(request, response, next\) => \{\s*if \(!canManageRegion\(request\.user\)\) return response\.status\(403\)/);
  assert.match(route, /typeof wanted !== 'boolean'/);
  assert.match(route, /SELECT id FROM regions FOR UPDATE/);
  assert.match(route, /'user\.bulk_activate' : 'user\.bulk_deactivate'/);
  const html = read('public/dashboard/index.html');
  const view = html.slice(html.indexOf('<section id="users-view"'), html.indexOf('<form id="region-form"'));
  assert.match(view, /<div class="heading-actions" data-super-only hidden>[^]*id="bulk-activate-button"[^]*id="bulk-deactivate-button"/);
  const script = read(`public/dashboard/dashboard.v${version}.js`);
  assert.match(script, /api\("\/api\/admin\/users\/bulk-active", \{ method: "POST", body: \{ active: wanted \} \}\)/);
  assert.match(script, /"user\.bulk_activate": "فعال‌سازی کلی کاربران"/);
  assert.match(script, /"user\.bulk_deactivate": "غیرفعال‌سازی کلی کاربران"/);
});
