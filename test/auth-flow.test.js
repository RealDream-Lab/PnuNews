import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/app.js';
import { base32Decode, generateTotp, hashPassword } from '../src/auth/crypto.js';
import { hashToken } from '../src/auth/sessions.js';
import { createPool } from '../src/db.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig();

test('password login enrolls TOTP, trusted devices skip codes, and expired devices require TOTP', async () => {
  const pool = createPool(config.db);
  const username = `auth-${randomBytes(6).toString('hex')}`;
  let password = 'local-test-password-2026';
  let userId;
  let now = Date.now();
  const app = createApp({ pool, config, clock: () => now });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const cookieJar = new Map();

  async function request(path, { method = 'GET', body, origin = baseUrl, contentType = 'application/json', fetchSite } = {}) {
    const headers = { origin };
    if (fetchSite) headers['sec-fetch-site'] = fetchSite;
    if (cookieJar.size) headers.cookie = [...cookieJar].map(([name, value]) => `${name}=${value}`).join('; ');
    if (body !== undefined) {
      headers['content-type'] = contentType;
    }
    const response = await fetch(new URL(path, baseUrl), {
      method,
      headers,
      body: body === undefined ? undefined : contentType === 'application/json' ? JSON.stringify(body) : body,
    });
    for (const value of response.headers.getSetCookie()) {
      const [pair, ...attributes] = value.split(';');
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator);
      const token = pair.slice(separator + 1);
      if (!token || attributes.some((attribute) => attribute.trim().toLowerCase() === 'max-age=0' || attribute.trim().toLowerCase().startsWith('expires=thu, 01 jan 1970'))) cookieJar.delete(name);
      else cookieJar.set(name, token);
    }
    const json = await response.json();
    return { response, json };
  }

  try {
    const [[root]] = await pool.query("SELECT id FROM regions WHERE code = 'IR'");
    const passwordHash = await hashPassword(password);
    const [inserted] = await pool.execute(
      `INSERT INTO users (username, password_hash, full_name, role, region_id, is_active)
       VALUES (?, ?, 'کاربر آزمون', 'super_admin', ?, 1)`,
      [username, passwordHash, root.id],
    );
    userId = inserted.insertId;

    const badOrigin = await request('/api/auth/login', {
      method: 'POST',
      origin: 'https://attacker.invalid',
      fetchSite: 'same-origin',
      body: { username, password },
    });
    assert.equal(badOrigin.response.status, 403);
    const wrongType = await request('/api/auth/login', {
      method: 'POST',
      contentType: 'text/plain',
      body: 'username=test',
    });
    assert.equal(wrongType.response.status, 415);

    const login = await request('/api/auth/login', { method: 'POST', body: { username, password } });
    assert.equal(login.json.next, 'totp_setup');
    assert.ok(cookieJar.has('pnu_pending'));

    const setup = await request('/api/auth/totp/setup');
    assert.match(setup.json.qr_svg, /<svg/);
    const secretBytes = base32Decode(setup.json.secret);
    const enrollCode = generateTotp(secretBytes, { time: now });
    const enrollment = await request('/api/auth/totp/enable', { method: 'POST', body: { code: enrollCode } });
    assert.equal(enrollment.response.status, 200);
    assert.equal(enrollment.json.backup_codes.length, 10);
    assert.match([...cookieJar].find(([name]) => name === 'pnu_session')[1], /^[A-Za-z\d_-]{43}$/);
    assert.equal(cookieJar.has('pnu_pending'), false);
    const sessionCookie = enrollment.response.headers.getSetCookie().find((value) => value.startsWith('pnu_session='));
    assert.match(sessionCookie, /Max-Age=86400/i);

    await pool.execute('UPDATE users SET must_change_password = 1 WHERE id = ?', [userId]);
    const me = await request('/api/auth/me');
    assert.equal(me.json.user.username, username);
    assert.equal(me.json.user.must_change_password, true);
    const blockedDevices = await request('/api/auth/devices');
    assert.equal(blockedDevices.response.status, 403);

    const changedPassword = 'new-local-test-password-2026';
    const passwordChange = await request('/api/auth/change-password', {
      method: 'POST',
      body: { old_password: password, new_password: changedPassword },
    });
    assert.equal(passwordChange.json.reauthentication_required, true);
    assert.equal(cookieJar.has('pnu_session'), false);
    const oldPasswordLogin = await request('/api/auth/login', { method: 'POST', body: { username, password } });
    assert.equal(oldPasswordLogin.response.status, 401);
    password = changedPassword;
    const dailyLogin = await request('/api/auth/login', { method: 'POST', body: { username, password } });
    assert.equal(dailyLogin.json.next, 'totp');
    now += 31_000;
    const totp = await request('/api/auth/totp', {
      method: 'POST',
      body: { code: generateTotp(secretBytes, { time: now }) },
    });
    assert.equal(totp.response.status, 200);
    assert.ok(cookieJar.has('pnu_device'));
    const deviceCookie = totp.response.headers.getSetCookie().find((value) => value.startsWith('pnu_device='));
    assert.match(deviceCookie, /Max-Age=2592000/i);

    await request('/api/auth/logout', { method: 'POST', body: {} });
    const rememberedLogin = await request('/api/auth/login', { method: 'POST', body: { username, password } });
    assert.equal(rememberedLogin.json.ok, true);
    assert.equal(rememberedLogin.json.next, undefined);

    const deviceToken = cookieJar.get('pnu_device');
    await pool.execute('UPDATE trusted_devices SET expires_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 SECOND) WHERE token_hash = ?', [hashToken(deviceToken)]);
    await request('/api/auth/logout', { method: 'POST', body: {} });
    const expiredDeviceLogin = await request('/api/auth/login', { method: 'POST', body: { username, password } });
    assert.equal(expiredDeviceLogin.json.next, 'totp');
    const replay = await request('/api/auth/totp', {
      method: 'POST',
      body: { code: generateTotp(secretBytes, { time: now }) },
    });
    assert.equal(replay.response.status, 401);

    now += 30_000;
    const freshCode = await request('/api/auth/totp', {
      method: 'POST',
      body: { code: generateTotp(secretBytes, { time: now }), remember: false },
    });
    assert.equal(freshCode.response.status, 200);
    await request('/api/auth/logout', { method: 'POST', body: {} });
    const nextPending = await request('/api/auth/login', { method: 'POST', body: { username, password } });
    assert.equal(nextPending.json.next, 'totp');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failedCode = await request('/api/auth/totp', { method: 'POST', body: { code: 'not-a-code' } });
      assert.equal(failedCode.response.status, 401);
    }
    const locked = await request('/api/auth/totp', { method: 'POST', body: { code: 'not-a-code' } });
    assert.equal(locked.response.status, 429);
  } finally {
    if (userId) await pool.execute('DELETE FROM users WHERE id = ?', [userId]);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
});
