import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { createApp, contentSecurityPolicy } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { isObviouslyInternalHost, isPrivateAddress, readLimitedText, resolvesToPublicAddress } from '../src/lib/net-guard.js';
import { sanitizeBodyHtml } from '../src/news/content.js';
import { createPublicRouter } from '../src/routes/public.js';

const baseEnv = {
  PORT: '3010', NODE_ENV: 'production', PUBLIC_URL: 'https://news.example.ir', DB_HOST: 'db', DB_PORT: '3306',
  DB_NAME: 'n', DB_USER: 'n', DB_PASSWORD: 'a-real-database-password', UPLOAD_DIR: '/tmp/u',
  APP_SECRET: 'a3f1c9d27be04586a3f1c9d27be04586a3f1c9d27be04586a3f1c9d27be04586',
};

test('production config rejects public sample secrets and plain http', () => {
  assert.doesNotThrow(() => loadConfig(baseEnv));
  assert.throws(() => loadConfig({ ...baseEnv, APP_SECRET: '0123456789abcdef'.repeat(4) }), /APP_SECRET/);
  assert.throws(() => loadConfig({ ...baseEnv, APP_SECRET: 'a'.repeat(64) }), /APP_SECRET/);
  assert.throws(() => loadConfig({ ...baseEnv, DB_PASSWORD: 'pnu_news_dev_only' }), /DB_PASSWORD/);
  assert.throws(() => loadConfig({ ...baseEnv, PUBLIC_URL: 'http://news.example.ir' }), /https/);
  // Development keeps working with the shipped example values.
  assert.doesNotThrow(() => loadConfig({ ...baseEnv, NODE_ENV: 'development', PUBLIC_URL: 'http://localhost:3010', APP_SECRET: '0123456789abcdef'.repeat(4) }));
});

test('net guard classifies internal and public addresses', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '185.51.200.2', '2606:4700:4700::1111']) {
    assert.equal(isPrivateAddress(address), false, address);
  }
  assert.equal(isObviouslyInternalHost('localhost'), true);
  assert.equal(isObviouslyInternalHost('radio.local'), true);
  assert.equal(isObviouslyInternalHost('[::1]'), true);
  assert.equal(isObviouslyInternalHost('radio.pnu.ac.ir'), false);
  assert.equal(await resolvesToPublicAddress('radio.example', async () => [{ address: '8.8.8.8' }]), true);
  assert.equal(await resolvesToPublicAddress('rebind.example', async () => [{ address: '8.8.8.8' }, { address: '10.0.0.5' }]), false);
  assert.equal(await resolvesToPublicAddress('gone.example', async () => { throw new Error('ENOTFOUND'); }), false);
});

test('readLimitedText stops oversized bodies', async () => {
  assert.equal(await readLimitedText(new Response('{"ok":true}'), 1024), '{"ok":true}');
  await assert.rejects(() => readLimitedText(new Response('x'.repeat(5000)), 1024), /too large/);
});

test('sanitizer keeps only uploaded images and hardens links', () => {
  const html = sanitizeBodyHtml([
    '<p onclick="x()">متن<script>alert(1)</script></p>',
    '<a href="javascript:alert(1)">bad</a>',
    '<a href="https://pnu.ac.ir" target="_self" rel="opener">ok</a>',
    '<a href="https://pnu.ac.ir" target="_blank">blank</a>',
    '<img src="https://evil.example/x.png">',
    '<img src="/media/../api/auth/me">',
    '<img src="/media/img/2026/10/0123456789abcdef0123456789abcdef-800.webp" alt="good">',
  ].join(''));
  assert.ok(!html.includes('script') && !html.includes('onclick') && !html.includes('javascript:'));
  assert.ok(!html.includes('evil.example') && !html.includes('/media/../'));
  assert.ok(html.includes('0123456789abcdef0123456789abcdef-800.webp'));
  assert.ok(!html.includes('rel="opener"'));
  assert.ok(!html.includes('target="_self"'));
  // The javascript: link loses its href but every remaining <a> carries the hardened rel.
  assert.equal((html.match(/<a /g) ?? []).length, (html.match(/rel="noopener noreferrer nofollow"/g) ?? []).length);
  assert.ok(html.includes('target="_blank"'));
});

test('CSP forbids plugins, base tag and foreign form targets', () => {
  const policy = contentSecurityPolicy('https://news.example.ir');
  for (const directive of ["object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"]) {
    assert.ok(policy.includes(directive), directive);
  }
});

async function request(server, path, options = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: options.headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

test('app sets security headers and marks auth/admin responses as no-store', async () => {
  const config = { publicUrl: 'https://news.example.ir', nodeEnv: 'production', trustProxy: false, appSecret: 'x'.repeat(64), uploadDir: '/tmp/u' };
  const app = createApp({ pool: {}, config, staticAssets: null });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const health = await request(server, '/healthz');
    assert.equal(health.headers['x-frame-options'], 'DENY');
    assert.equal(health.headers['strict-transport-security'], 'max-age=31536000');
    assert.equal(health.headers['cross-origin-opener-policy'], 'same-origin');
    const admin = await request(server, '/api/admin/stats');
    assert.equal(admin.status, 401);
    assert.equal(admin.headers['cache-control'], 'no-store');
    const auth = await request(server, '/api/auth/me');
    assert.equal(auth.headers['cache-control'], 'no-store');
    // Cross-site state changes are refused before reaching any handler.
    const forged = await request(server, '/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
    assert.equal(forged.status, 403);
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
});

test('login counts failures per address and globally, keyed by the canonical username', async () => {
  const calls = [];
  const pool = {
    execute: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM users WHERE username/.test(sql)) return [[]];
      if (/COUNT\(\*\) AS locked/.test(sql)) return [[{ locked: 0 }]];
      return [[], []];
    },
  };
  const config = { publicUrl: 'https://news.example.ir', nodeEnv: 'production', trustProxy: false, appSecret: 'b'.repeat(64), uploadDir: '/tmp/u' };
  const app = createApp({ pool, config, staticAssets: null });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const headers = { 'content-type': 'application/json', origin: `http://127.0.0.1:${server.address().port}` };
    const attempt = (username) => request(server, '/api/auth/login', { method: 'POST', headers, body: JSON.stringify({ username, password: 'wrong-password-123' }) });
    assert.equal((await attempt('Admin')).status, 401);
    assert.equal((await attempt('aDMIN')).status, 401);
    const failures = calls.filter((call) => /INSERT INTO login_attempts/.test(call.sql));
    assert.equal(failures.length, 4); // two attempts x (per-address + global)
    // Differently-cased spellings of one name share the same counters.
    assert.deepEqual(failures[0].params[1], failures[2].params[1]);
    assert.deepEqual(failures[0].params[0], failures[2].params[0]);
    assert.notDeepEqual(failures[0].params[0], failures[1].params[0]);
    assert.equal(failures[0].params[2] ?? failures[0].params.at(-1), 5);
    assert.equal(failures[1].params.at(-1), 30);
    // Oversized credentials are rejected without touching the database.
    const before = calls.length;
    assert.equal((await attempt('x'.repeat(500))).status, 401);
    assert.equal(calls.length, before);
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
});

test('news share page does not interpret $-patterns in titles', async () => {
  const shell = '<!doctype html><html><head><title>x</title><meta name="description" content="d"></head><body></body></html>';
  const staticAssets = new Map([['/index.html', { body: Buffer.from(shell) }]]);
  const pool = {
    execute: async () => [[{ title: "A $& B $` C $' D", summary: '$`', news_type: 'news', published_at: new Date(), stored_name: null, site_title: 'Site' }]],
  };
  const app = express();
  app.use(createPublicRouter({ pool, config: { publicUrl: 'https://news.example.ir' }, staticAssets }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const page = await request(server, '/n/1');
    assert.equal(page.status, 200);
    assert.ok(page.body.includes('A $&amp; B $` C $&#39; D'), page.body);
    assert.equal((page.body.match(/<\/head>/g) ?? []).length, 1);
    assert.equal((page.body.match(/<title>/g) ?? []).length, 1);
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
});

test('feed honours the reader\'s news-source choices and validates them', async () => {
  const queries = [];
  const city = { id: 11, name: 'بیجار', province_id: 5, province_name: 'کردستان', country_id: 1 };
  const pool = {
    execute: async (sql, params) => {
      const placeholders = (sql.match(/\?/g) ?? []).length;
      assert.equal(placeholders, params.length, `placeholder/param mismatch in: ${sql.slice(0, 80)}`);
      queries.push({ sql, params });
      if (/FROM regions city/.test(sql)) return [[city]];
      if (/FROM regions sibling/.test(sql)) return [[{ id: 12 }, { id: 13 }]];
      return [[]];
    },
  };
  const app = express();
  app.use(createPublicRouter({ pool, config: { publicUrl: 'https://news.example.ir' } }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const feedQuery = () => queries.filter((query) => /FROM news n/.test(query.sql));
    assert.equal((await request(server, '/api/public/feed?city=11&country=2')).status, 400);

    queries.length = 0;
    assert.equal((await request(server, '/api/public/feed?city=11')).status, 200);
    assert.deepEqual(feedQuery()[0].params.slice(0, 3), [11, 1, 5]); // own center, country, province

    queries.length = 0;
    assert.equal((await request(server, '/api/public/feed?city=11&country=0&province=0&siblings=1')).status, 200);
    assert.deepEqual(feedQuery()[0].params.slice(0, 3), [11, 12, 13]); // own center + siblings only
    assert.ok(!feedQuery()[0].params.slice(0, 3).includes(1));

    queries.length = 0;
    assert.equal((await request(server, '/api/public/feed?city=11&country=0&province=0')).status, 200);
    assert.deepEqual(feedQuery()[0].params.slice(0, 1), [11]);
    assert.equal(queries.some((query) => /FROM regions sibling/.test(query.sql)), false);
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
});
