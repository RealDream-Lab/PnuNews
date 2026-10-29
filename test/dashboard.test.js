import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { createStaticAssets } from '../src/lib/static.js';

const config = { publicUrl: 'https://news.example.ir', nodeEnv: 'production', trustProxy: false, appSecret: 'x'.repeat(64), uploadDir: '/tmp/u' };

async function get(server, path) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

test('dashboard lives at /dashboard, /admin redirects there, and it is an installable web app', async () => {
  const staticAssets = await createStaticAssets(fileURLToPath(new URL('../public/', import.meta.url)));
  const server = http.createServer(createApp({ pool: {}, config, staticAssets }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const page = await get(server, '/dashboard');
    assert.equal(page.status, 200);
    assert.match(page.body, /<link rel="manifest" href="\/dashboard\/manifest\.webmanifest"/);
    assert.ok(!page.body.includes('/admin/'), 'the page must not reference /admin/ any more');

    for (const [from, to] of [['/admin', '/dashboard'], ['/admin/', '/dashboard/'], ['/admin?x=1', '/dashboard?x=1']]) {
      const moved = await get(server, from);
      assert.equal(moved.status, 301, from);
      assert.equal(moved.headers.location, to, from);
    }
    // The JSON API keeps its path and is not caught by the page redirect.
    assert.equal((await get(server, '/api/admin/stats')).status, 401);

    for (const name of ['manifest', 'manifest-dark', 'manifest-mobile', 'manifest-mobile-dark']) {
      const response = await get(server, `/dashboard/${name}.webmanifest`);
      assert.equal(response.status, 200, name);
      const manifest = JSON.parse(response.body);
      assert.equal(manifest.scope, '/dashboard/');
      assert.equal(manifest.start_url, '/dashboard/');
      assert.equal(manifest.id, '/dashboard/');
      assert.equal(manifest.display === 'standalone', true);
      assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512'));
    }

    const worker = await get(server, '/dashboard/sw.js');
    assert.equal(worker.status, 200);
    assert.match(worker.headers['content-type'], /javascript/);
    assert.equal(worker.headers['cache-control'], 'no-cache');
    // Every file the worker pre-caches must exist, or installing the worker would fail.
    const assets = [...worker.body.matchAll(/'(\/[^']+)'/g)].map((match) => match[1]).filter((path) => !path.endsWith('/') || path === '/dashboard/');
    for (const path of assets) assert.equal((await get(server, path)).status, 200, path);
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
});
