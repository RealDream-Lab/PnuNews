import assert from 'node:assert/strict';
import test from 'node:test';
import { parseProxyNews } from '../src/portal-parse.js';
import { PORTAL_SOURCE_URL, createCachedPortalPayload, fetchPortalHtml, fetchPortalPayload, parsePortalHtml } from '../src/portal-scrape.js';

const panel = (n, { title = `خبر ${n}`, unix = 1_761_990_000_000 + n, image = `/Portals/0/${n}.jpg`, abstract = `خلاصهٔ ${n}` } = {}) => `
<div id="dnn_ctr6021_List_rpt_ctl0${n}_NewsContentPanel" class="item">
  <div class="pic"><a href="/x"><img alt="" src="${image}"></a></div>
  <a id="dnn_ctr6021_List_rpt_ctl0${n}_Title" class="bold DPNewsItemTitle big" href="/fa-IR/DouranPortal/6021/page/n${n}">${title}</a>
  <span id="dnn_ctr6021_List_rpt_ctl0${n}_DetailsDatePanel" unix="${unix}">
    <span id="dnn_ctr6021_List_rpt_ctl0${n}_DetailsSubmitDate"> ۱۴۰۵/۰۸/۱۰ </span>
    <span id="dnn_ctr6021_List_rpt_ctl0${n}_DetailsSubmitTime">۱۲:۳۰</span>
  </span>
  <span id="dnn_ctr6021_List_rpt_ctl0${n}_NewsAbstract">${abstract}</span>
  <span id="dnn_ctr6021_List_rpt_ctl0${n}_NewsAbstractMorePanel">ادامه</span>
</div>`;
const page = (...panels) => `<!doctype html><html><body><div id="wrap">${panels.join('\n')}</div></body></html>`;

test('parse: fields are read like proxy.php did', () => {
  const [item] = parsePortalHtml(page(panel(1, { title: '  عنوان   با\n فاصله  ', abstract: 'متن   خلاصه &amp; بیشتر' })));
  assert.equal(item.title, 'عنوان با فاصله');
  assert.equal(item.link, 'https://pnu.ac.ir/fa-IR/DouranPortal/6021/page/n1');
  assert.equal(item.image, 'https://pnu.ac.ir/Portals/0/1.jpg');
  assert.equal(item.abstract, 'متن خلاصه & بیشتر');
  assert.equal(item.date, '۱۴۰۵/۰۸/۱۰');
  assert.equal(item.time, '۱۲:۳۰');
  assert.equal(item.timestamp_ms, 1_761_990_000_001);
});

test('parse: the "more" span is not the abstract, incomplete items are skipped, the limit is honoured', () => {
  const broken = '<div id="x_NewsContentPanel"><span id="x_NewsAbstract">بدون عنوان</span></div>';
  const items = parsePortalHtml(page(broken, ...[1, 2, 3, 4].map((n) => panel(n))), 3);
  assert.deepEqual(items.map((item) => item.title), ['خبر 1', 'خبر 2', 'خبر 3']);
  assert.ok(items.every((item) => !item.abstract.includes('ادامه')));
});

test('parse: missing optional parts become null / empty instead of failing', () => {
  const html = '<div id="a_NewsContentPanel"><a class="DPNewsItemTitle" href="/p/1">فقط عنوان</a></div>';
  const [item] = parsePortalHtml(html);
  assert.deepEqual(item, { title: 'فقط عنوان', link: 'https://pnu.ac.ir/p/1', image: null, abstract: '', date: null, time: null, timestamp_ms: null });
});

test('payload: has the proxy.php shape and goes through the importer parser unchanged', async () => {
  const payload = await fetchPortalPayload({ fetchHtml: async () => page(panel(1), panel(2)), now: () => new Date('2026-11-01T10:00:00Z') });
  assert.equal(payload.source, PORTAL_SOURCE_URL);
  assert.equal(payload.count, 2);
  assert.equal(payload.fetched_at, '2026-11-01T10:00:00.000Z');
  const items = parseProxyNews(payload, 20);
  assert.equal(items.length, 2);
  assert.equal(items[0].link, 'https://pnu.ac.ir/fa-IR/DouranPortal/6021/page/n1');
});

test('payload: a page without news is reported as a structure change', async () => {
  await assert.rejects(fetchPortalPayload({ fetchHtml: async () => '<html><body>سایت در دست تعمیر</body></html>' }), /ساختار صفحه/);
});

const connectFailure = () => Object.assign(new Error('timeout'), { connectFailed: true });

test('fetch: only connection failures are retried, and the third attempt can succeed', async () => {
  let calls = 0;
  const html = await fetchPortalHtml({
    request: async () => { calls += 1; if (calls < 3) throw connectFailure(); return { status: 200, body: 'ok', location: null }; },
  });
  assert.equal(html, 'ok');
  assert.equal(calls, 3);
});

test('fetch: an error after the connection was made is not retried; exhausted retries give a clear error', async () => {
  let calls = 0;
  await assert.rejects(fetchPortalHtml({ request: async () => { calls += 1; throw new Error('reset'); } }), /خطا در دریافت صفحه: reset/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(fetchPortalHtml({ request: async () => { calls += 1; throw connectFailure(); } }), /خطا در دریافت صفحه/);
  assert.equal(calls, 3);
});

test('fetch: HTTP errors fail; redirects are followed only inside pnu.ac.ir', async () => {
  await assert.rejects(fetchPortalHtml({ request: async () => ({ status: 503, body: '', location: null }) }), /503/);

  const seen = [];
  const html = await fetchPortalHtml({
    request: async (target) => {
      seen.push(target);
      return seen.length === 1 ? { status: 301, body: '', location: '/fa-IR/new' } : { status: 200, body: 'moved', location: null };
    },
  });
  assert.equal(html, 'moved');
  assert.equal(seen[1], 'https://pnu.ac.ir/fa-IR/new');

  await assert.rejects(
    fetchPortalHtml({ request: async () => ({ status: 302, body: '', location: 'https://evil.example/x' }) }),
    /نامعتبر/,
  );
  await assert.rejects(
    fetchPortalHtml({ request: async () => ({ status: 302, body: '', location: 'http://pnu.ac.ir/x' }) }),
    /نامعتبر/,
  );
});

// ---------- 3-minute cache ----------

const cacheHtml = page(panel(1), panel(2));
const cacheHarness = () => {
  let now = 1_000_000;
  let fetches = 0;
  const feed = createCachedPortalPayload({
    clock: () => now,
    fetchHtml: async () => { fetches += 1; return cacheHtml; },
  });
  return { feed, advance: (ms) => { now += ms; }, fetchCount: () => fetches };
};

test('cache: a second call inside 3 minutes reuses the payload, the next one after 3 minutes fetches again', async () => {
  const { feed, advance, fetchCount } = cacheHarness();
  const first = await feed();
  advance(2 * 60_000);
  assert.equal(await feed(), first);
  assert.equal(fetchCount(), 1);
  advance(60_000); // exactly 3 minutes after the first fetch: the importer timer must not be served from cache
  await feed();
  assert.equal(fetchCount(), 2);
});

test('cache: force skips the cache only when the cached list is at least 30 seconds old', async () => {
  const { feed, advance, fetchCount } = cacheHarness();
  await feed();
  advance(10_000);
  await feed({ force: true });
  assert.equal(fetchCount(), 1);
  advance(25_000);
  await feed({ force: true });
  assert.equal(fetchCount(), 2);
});

test('cache: concurrent calls share one fetch and a failure is not cached', async () => {
  let fetches = 0;
  let fail = true;
  const feed = createCachedPortalPayload({
    fetchHtml: async () => { fetches += 1; if (fail) throw new Error('down'); return cacheHtml; },
  });
  await Promise.all([feed().catch(() => {}), feed().catch(() => {})]);
  assert.equal(fetches, 1);
  await assert.rejects(feed(), /down/);
  fail = false;
  const payload = await feed();
  assert.equal(payload.count, 2);
  assert.equal(fetches, 3);
});
