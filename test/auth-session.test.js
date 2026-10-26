import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cookieName,
  cookieOptions,
  createPendingStore,
  DEVICE_TTL_SECONDS,
  PENDING_TTL_SECONDS,
  SESSION_TTL_SECONDS,
} from '../src/auth/sessions.js';

test('session and trusted-device cookies have fixed lifetimes and secure production names', () => {
  const now = Date.UTC(2026, 0, 1);
  const session = cookieOptions('session', 'production', now);
  const device = cookieOptions('device', 'production', now);
  assert.equal(cookieName('session', 'production'), '__Host-pnu_session');
  assert.equal(cookieName('device', 'production'), '__Host-pnu_device');
  assert.equal(session.maxAge, SESSION_TTL_SECONDS * 1000);
  assert.equal(device.maxAge, DEVICE_TTL_SECONDS * 1000);
  assert.equal(session.expires.getTime(), now + 24 * 60 * 60 * 1000);
  assert.equal(device.expires.getTime(), now + 30 * 24 * 60 * 60 * 1000);
  assert.equal(session.httpOnly, true);
  assert.equal(session.secure, true);
  assert.equal(session.sameSite, 'lax');
  assert.equal(session.path, '/');
  assert.equal(cookieName('session', 'development'), 'pnu_session');
  assert.equal(cookieOptions('session', 'development').secure, false);
});

test('pending authentication credentials expire after ten minutes using the injected clock', () => {
  let now = 1000;
  const pending = createPendingStore(() => now);
  const token = pending.issue(42);
  assert.equal(pending.get(token).userId, 42);
  now += PENDING_TTL_SECONDS * 1000 - 1;
  assert.ok(pending.get(token));
  now += 1;
  assert.equal(pending.get(token), null);
  assert.equal(pending.size(), 0);
});
