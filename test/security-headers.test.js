import assert from 'node:assert/strict';
import test from 'node:test';
import { contentSecurityPolicy } from '../src/app.js';

test('production CSP permits HTTPS radio media but blocks insecure HTTP media', () => {
  const policy = contentSecurityPolicy('https://news.example');
  assert.match(policy, /media-src 'self' https:/);
  assert.doesNotMatch(policy, /media-src[^;]*\bhttp:/);
  assert.match(policy, /img-src 'self' data:/);
  assert.match(policy, /script-src 'self'; style-src 'self'; frame-ancestors 'none'/);
});

test('development CSP permits HTTP radio streams only on the local HTTP site', () => {
  const policy = contentSecurityPolicy('http://127.0.0.1:3010');
  assert.match(policy, /media-src 'self' https: http:/);
});
