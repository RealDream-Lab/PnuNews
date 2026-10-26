import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth/crypto.js';
import { createSession, createTrustedDevice, hashToken } from '../src/auth/sessions.js';
import { createPool } from '../src/db.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig();

test('admin API enforces scoped user management, city limits, revocation, regions, and audit', async () => {
  const pool = createPool(config.db);
  const suffix = randomBytes(6).toString('hex');
  const usernames = [`root-${suffix}`, `province-${suffix}`];
  const userIds = [];
  let oldMaxCityAdmins;
  let createdRegionId;
  const app = createApp({ pool, config });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function addUser(username, role, regionId) {
    const [passwordHash] = await Promise.all([hashPassword(`temporary-password-${suffix}`)]);
    const [result] = await pool.execute(
      `INSERT INTO users (username, password_hash, full_name, role, region_id, is_active, must_change_password)
       VALUES (?, ?, ?, ?, ?, 1, 0)`,
      [username, passwordHash, username, role, regionId],
    );
    userIds.push(result.insertId);
    const session = await createSession(pool, result.insertId, { ip: '127.0.0.1', get: () => 'admin-api-test' });
    return { id: result.insertId, cookie: `pnu_session=${session.token}` };
  }

  async function api(cookie, path, { method = 'GET', body } = {}) {
    const response = await fetch(new URL(path, baseUrl), {
      method,
      headers: {
        origin: baseUrl,
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { response, json: await response.json() };
  }

  try {
    const [pairs] = await pool.query(
      `SELECT p.id AS province_id, c.id AS city_id
       FROM regions p JOIN regions c ON c.parent_id = p.id
       WHERE p.type = 'province' AND c.type = 'city'
       ORDER BY p.sort_order, c.sort_order LIMIT 2`,
    );
    assert.ok(pairs.length >= 2);
    const [rootRows] = await pool.execute('SELECT id FROM regions WHERE code = ?', ['IR']);
    const superAdmin = await addUser(usernames[0], 'super_admin', rootRows[0].id);

    const [settingRows] = await pool.execute('SELECT v FROM settings WHERE k = ?', ['max_city_admins']);
    oldMaxCityAdmins = settingRows[0]?.v ?? '1';
    await pool.execute("INSERT INTO settings (k, v) VALUES ('max_city_admins', '1') ON DUPLICATE KEY UPDATE v = '1'");

    const provinces = await api(superAdmin.cookie, '/api/admin/users', { method: 'POST', body: {
      username: usernames[1], full_name: 'مدیر استان آزمون', role: 'province_admin', region_id: pairs[0].province_id,
    } });
    assert.equal(provinces.response.status, 201);
    assert.equal(provinces.json.role, 'province_admin');
    assert.ok(provinces.json.temporary_password.length >= 10);
    userIds.push(provinces.json.id);
    await pool.execute('UPDATE users SET must_change_password = 0 WHERE id = ?', [provinces.json.id]);
    const provinceSession = await createSession(pool, provinces.json.id, { ip: '127.0.0.1', get: () => 'province-api-test' });
    const provinceAdmin = { id: provinces.json.id, cookie: `pnu_session=${provinceSession.token}` };

    const cityPayload = { username: `city-${suffix}`, full_name: 'مدیر شهر آزمون', role: 'city_admin', region_id: pairs[0].city_id };
    const firstCity = await api(provinceAdmin.cookie, '/api/admin/users', { method: 'POST', body: cityPayload });
    assert.equal(firstCity.response.status, 201);
    const cityUserId = firstCity.json.id;
    userIds.push(cityUserId);

    const duplicateCity = await api(provinceAdmin.cookie, '/api/admin/users', { method: 'POST', body: { ...cityPayload, username: `duplicate-${suffix}` } });
    assert.equal(duplicateCity.response.status, 409);
    assert.match(duplicateCity.json.error, /مدیر فعال/);

    await pool.execute('UPDATE users SET must_change_password = 0 WHERE id = ?', [cityUserId]);
    const citySession = await createSession(pool, cityUserId, { ip: '127.0.0.1', get: () => 'city-api-test' });
    const cityCookie = `pnu_session=${citySession.token}`;
    const cityUsers = await api(cityCookie, '/api/admin/users');
    assert.deepEqual(cityUsers.json.users, []);
    const selfRoleEdit = await api(cityCookie, `/api/admin/users/${cityUserId}`, { method: 'PATCH', body: { role: 'province_admin', region_id: pairs[1].city_id } });
    assert.equal(selfRoleEdit.response.status, 400);
    const selfNameEdit = await api(cityCookie, `/api/admin/users/${cityUserId}`, { method: 'PATCH', body: { full_name: 'نام تازهٔ آزمون' } });
    assert.equal(selfNameEdit.response.status, 200);

    const devices = await createTrustedDevice(pool, cityUserId, { ip: '127.0.0.1', get: () => 'city-device-test' });
    const provinceUsers = await api(provinceAdmin.cookie, '/api/admin/users');
    assert.ok(provinceUsers.json.users.some((user) => user.id === cityUserId));
    const visibleTargets = await api(provinceAdmin.cookie, '/api/admin/regions');
    assert.ok(visibleTargets.json.regions.some((region) => region.id === pairs[0].province_id));
    assert.ok(visibleTargets.json.regions.some((region) => region.id === pairs[0].city_id));

    const provinceAudit = await api(provinceAdmin.cookie, '/api/admin/audit?limit=100');
    assert.ok(provinceAudit.json.items.some((item) => item.action === 'user.create' && item.entity_id === cityUserId));
    const forbiddenRegionEdit = await api(provinceAdmin.cookie, `/api/admin/regions/${pairs[0].city_id}`, { method: 'PATCH', body: { visibility_override: 'show' } });
    assert.equal(forbiddenRegionEdit.response.status, 403);

    const deactivated = await api(provinceAdmin.cookie, `/api/admin/users/${cityUserId}/deactivate`, { method: 'POST', body: {} });
    assert.equal(deactivated.json.ok, true);
    const [[deactivatedRow]] = await pool.execute('SELECT is_active FROM users WHERE id = ?', [cityUserId]);
    assert.equal(Number(deactivatedRow.is_active), 0);
    const [[sessionCount]] = await pool.execute('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?', [cityUserId]);
    const [[deviceCount]] = await pool.execute('SELECT COUNT(*) AS count FROM trusted_devices WHERE user_id = ?', [cityUserId]);
    assert.equal(Number(sessionCount.count), 0);
    assert.equal(Number(deviceCount.count), 0);
    assert.notEqual(hashToken(devices.token).length, 0);

    const replacementAttempts = await Promise.all([
      api(provinceAdmin.cookie, '/api/admin/users', { method: 'POST', body: { ...cityPayload, username: `replacement-a-${suffix}` } }),
      api(provinceAdmin.cookie, '/api/admin/users', { method: 'POST', body: { ...cityPayload, username: `replacement-b-${suffix}` } }),
    ]);
    assert.deepEqual(replacementAttempts.map((attempt) => attempt.response.status).sort(), [201, 409]);
    const replacement = replacementAttempts.find((attempt) => attempt.response.status === 201);
    userIds.push(replacement.json.id);

    const createdRegion = await api(superAdmin.cookie, '/api/admin/regions', { method: 'POST', body: {
      type: 'city', name: `منطقهٔ آزمایشی ${suffix}`, parent_id: pairs[1].province_id,
    } });
    assert.equal(createdRegion.response.status, 201);
    createdRegionId = createdRegion.json.id;
    const visibleRegion = await api(superAdmin.cookie, `/api/admin/regions/${createdRegion.json.id}`, { method: 'PATCH', body: { visibility_override: 'show' } });
    assert.equal(visibleRegion.response.status, 200);
    const [[regionState]] = await pool.execute('SELECT visibility_override FROM regions WHERE id = ?', [createdRegion.json.id]);
    assert.equal(regionState.visibility_override, 'show');
    const reset = await api(superAdmin.cookie, `/api/admin/users/${replacement.json.id}/reset-password`, { method: 'POST', body: {} });
    assert.equal(reset.response.status, 200);
    assert.ok(reset.json.temporary_password.length >= 10);
    const [[passwordState]] = await pool.execute('SELECT must_change_password FROM users WHERE id = ?', [replacement.json.id]);
    assert.equal(Number(passwordState.must_change_password), 1);
    const resetTotp = await api(superAdmin.cookie, `/api/admin/users/${replacement.json.id}/reset-2fa`, { method: 'POST', body: {} });
    assert.equal(resetTotp.json.ok, true);
    await pool.execute('DELETE FROM regions WHERE id = ?', [createdRegion.json.id]);
    createdRegionId = undefined;
  } finally {
    if (oldMaxCityAdmins !== undefined) {
      await pool.execute('UPDATE settings SET v = ? WHERE k = ?', [oldMaxCityAdmins, 'max_city_admins']);
    }
    if (createdRegionId) await pool.execute('DELETE FROM regions WHERE id = ?', [createdRegionId]);
    if (userIds.length) {
      const placeholders = userIds.map(() => '?').join(', ');
      await pool.execute(`DELETE FROM users WHERE id IN (${placeholders})`, userIds);
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
});
