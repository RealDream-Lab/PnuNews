import assert from 'node:assert/strict';
import test from 'node:test';
import {
  REMEMBER_TTL_SECONDS,
  SESSION_TTL_SECONDS,
  cookieName,
  cookieOptions,
  createPendingStore,
  isMobileUserAgent,
} from '../src/auth/sessions.js';

test('mobile detection: phones yes, desktop browsers no', () => {
  assert.equal(isMobileUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'), true);
  assert.equal(isMobileUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36'), true);
  assert.equal(isMobileUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15'), false);
  assert.equal(isMobileUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36'), false);
  assert.equal(isMobileUserAgent(''), false);
  assert.equal(isMobileUserAgent(undefined), false);
});

test('session cookie lasts 24 hours, or ten years only when remembered; the device cookie is gone', () => {
  const now = Date.UTC(2026, 10, 14);
  assert.equal(cookieOptions('session', 'production', now).maxAge, SESSION_TTL_SECONDS * 1000);
  assert.equal(cookieOptions('session', 'production', now, { remember: true }).maxAge, REMEMBER_TTL_SECONDS * 1000);
  assert.ok(REMEMBER_TTL_SECONDS > 365 * 24 * 60 * 60);
  assert.equal(cookieOptions('pending', 'production', now, { remember: true }).maxAge, 10 * 60 * 1000);
  assert.throws(() => cookieName('device', 'production'), TypeError);
});

test('pending login carries the remember choice to the second step', () => {
  let time = 1_000;
  const store = createPendingStore(() => time);
  const token = store.issue(7, time, { remember: true });
  assert.equal(store.get(token, time).remember, true);
  assert.equal(store.get(store.issue(8, time), time).remember, false);
  time += 11 * 60_000;
  assert.equal(store.get(token, time), null);
});
