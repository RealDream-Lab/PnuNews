import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(`${root}package.json`, 'utf8')).version;
const { NETWORK_ERROR_MESSAGE, fetchOrExplain } = await import(`${root}public/shared/network-error.v${version}.js`);
const read = (relative) => readFileSync(`${root}${relative}`, 'utf8');

async function withFetch(replacement, run) {
  const original = globalThis.fetch;
  globalThis.fetch = replacement;
  try { return await run(); } finally { globalThis.fetch = original; }
}

test('every browser\'s «could not reach the server» error becomes the same Persian message', async () => {
  for (const text of ['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.', 'The network connection was lost.']) {
    const cause = new TypeError(text);
    await withFetch(async () => { throw cause; }, async () => {
      await assert.rejects(() => fetchOrExplain('/api/public/news'), (error) => {
        assert.equal(error.message, NETWORK_ERROR_MESSAGE);
        assert.equal(error.network, true);
        assert.equal(error.status, 0);
        assert.equal(error.cause, cause, 'the original error is kept for debugging');
        assert.ok(!/[A-Za-z]{4,}/.test(error.message), 'nothing in English reaches the reader');
        return true;
      });
    });
  }
  assert.match(NETWORK_ERROR_MESSAGE, /اینترنت/);
});

test('a successful answer and a cancelled request pass through untouched', async () => {
  const response = new Response('{}');
  await withFetch(async () => response, async () => assert.equal(await fetchOrExplain('/x', { cache: 'no-store' }), response));
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  await withFetch(async () => { throw abort; }, async () => {
    await assert.rejects(() => fetchOrExplain('/x'), (error) => error === abort);
  });
});

test('the reader and the staff editor use it, the service worker keeps it for offline starts, and «no connection» is not «news not found»', () => {
  const app = read(`public/reader/app.v${version}.js`);
  assert.match(app, new RegExp(`import \\{ fetchOrExplain \\} from '/shared/network-error\\.v${version.replaceAll('.', '\\.')}\\.js'`));
  assert.match(app, /const response = await fetchOrExplain\(url, \{ headers: \{ accept: 'application\/json' \} \}\);/);
  assert.match(app, /<h1>\$\{error\.network \? 'ارتباط برقرار نشد' : 'خبر پیدا نشد'\}<\/h1>/);
  assert.match(read(`public/shared/inline-edit.v${version}.js`), /const response = await fetchOrExplain\(url, \{/);
  assert.match(read('public/sw.js'), new RegExp(`/shared/network-error\\.v${version.replaceAll('.', '\\.')}\\.js`));
});
