import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Runs public/sw.js in a sandbox with an in-memory Cache Storage and a scripted fetch(), then fires fetch events at it.
const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://news.test';
const FIRST_PAGE = `${ORIGIN}/api/public/feed?city=7&scope=all&limit=12`;

function createWorker() {
  const stores = new Map();
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        async put(request, response) { store.set(request.url ?? String(request), response); },
        async match(request) { return store.get(request.url ?? String(request))?.clone(); },
        async keys() { return [...store.keys()].map((url) => new Request(url)); },
        async delete(request) { return store.delete(request.url ?? String(request)); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async match() { return undefined; },
  };

  const handlers = {};
  const calls = [];
  let serverBody = 'server-v1';
  const sandbox = {
    self: { location: { origin: ORIGIN }, addEventListener: (type, handler) => { handlers[type] = handler; }, clients: { claim: async () => {} }, skipWaiting() {} },
    caches,
    URL,
    Request,
    Response,
    Promise,
    fetch: async (request, options = {}) => {
      calls.push({ url: request.url ?? String(request), cache: options.cache });
      return new Response(serverBody, { status: 200 });
    },
  };
  vm.runInNewContext(source, sandbox);

  return {
    calls,
    setServerBody(value) { serverBody = value; },
    async cachedBodies() {
      const store = stores.get('pnunews-last-feed-v2') ?? new Map();
      return Object.fromEntries(await Promise.all([...store].map(async ([url, response]) => [url, await response.clone().text()])));
    },
    // Fires a fetch event; `handled` is false when the worker left the request to the browser.
    async request(url) {
      const waits = [];
      let responded = null;
      handlers.fetch({
        request: new Request(url),
        respondWith(value) { responded = value; },
        waitUntil(value) { waits.push(value); },
      });
      const body = responded ? await (await responded).text() : null;
      await Promise.all(waits);
      return { handled: responded !== null, body };
    },
  };
}

test('feed: the first page is shown from the cache and refreshed in the background for the next visit', async () => {
  const worker = createWorker();
  worker.setServerBody('server-v1');
  const first = await worker.request(FIRST_PAGE);
  assert.equal(first.body, 'server-v1', 'with nothing cached the reader waits for the network');

  worker.setServerBody('server-v2');
  const second = await worker.request(FIRST_PAGE);
  assert.equal(second.body, 'server-v1', 'the cached first page paints immediately');
  assert.deepEqual(await worker.cachedBodies(), { [FIRST_PAGE]: 'server-v2' }, 'and the background refresh replaces it');
  assert.ok(worker.calls.every((call) => call.cache === 'no-cache'), 'revalidation must not be answered by the HTTP cache');
});

test('feed: a live check always reads the network and becomes the cached first page', async () => {
  const worker = createWorker();
  worker.setServerBody('server-v1');
  await worker.request(FIRST_PAGE);

  worker.setServerBody('server-v2');
  const live = await worker.request(`${FIRST_PAGE}&live=1730000000000`);
  assert.equal(live.body, 'server-v2', 'a cached answer must never satisfy a live check');
  assert.deepEqual(await worker.cachedBodies(), { [FIRST_PAGE]: 'server-v2' }, 'stored without the live parameter, so no stray entries');

  const next = await worker.request(FIRST_PAGE);
  assert.equal(next.body, 'server-v2', 'the next visit paints the newest first page');
});

test('feed: later pages are not handled and never evict the cached first page', async () => {
  const worker = createWorker();
  await worker.request(FIRST_PAGE);
  const later = await worker.request(`${FIRST_PAGE}&cursor=abc`);
  assert.equal(later.handled, false);
  assert.deepEqual(Object.keys(await worker.cachedBodies()), [FIRST_PAGE]);
});

test('feed: other cities keep their own cached first page, bounded to a handful', async () => {
  const worker = createWorker();
  for (let city = 1; city <= 12; city += 1) await worker.request(`${ORIGIN}/api/public/feed?city=${city}&scope=all&limit=12`);
  const keys = Object.keys(await worker.cachedBodies());
  assert.equal(keys.length, 8);
  assert.ok(keys.at(-1).includes('city=12'));
});
