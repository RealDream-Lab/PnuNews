import test from 'node:test';
import assert from 'node:assert/strict';
import { brotliDecompressSync } from 'node:zlib';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { createStaticAssets, createStaticMiddleware } from '../src/lib/static.js';

test('static asset map precompresses files, negotiates Brotli, caches versions, and supports ETags', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pnunews-static-'));
  const source = '<!doctype html><html lang="fa"><body>خبر آزمایشی</body></html>';
  try {
    await writeFile(path.join(root, 'index.html'), source);
    await writeFile(path.join(root, 'reader.v1.js'), 'export const ok = true;');
    const assets = await createStaticAssets(root);
    const app = express();
    app.use(createStaticMiddleware(assets));
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const address = `http://127.0.0.1:${server.address().port}`;
    try {
      const response = await new Promise((resolve, reject) => {
        http.get(`${address}/`, { headers: { 'accept-encoding': 'br' } }, (incoming) => {
          const chunks = [];
          incoming.on('data', (chunk) => chunks.push(chunk));
          incoming.on('end', () => resolve({ status: incoming.statusCode, headers: incoming.headers, body: Buffer.concat(chunks) }));
        }).on('error', reject);
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers['content-encoding'], 'br');
      assert.equal(brotliDecompressSync(response.body).toString(), source);
      assert.equal(response.headers['cache-control'], 'no-cache');
      assert.match(response.headers.etag, /^".+"$/);

      const versioned = await fetch(`${address}/reader.v1.js`);
      assert.equal(versioned.status, 200);
      assert.equal(versioned.headers.get('cache-control'), 'public, max-age=31536000, immutable');
      const conditional = await fetch(`${address}/`, { headers: { 'if-none-match': response.headers.etag } });
      assert.equal(conditional.status, 304);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
