import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createPublicRouter } from '../src/routes/public.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(`${root}package.json`, 'utf8')).version;
const { createBookmarkStore } = await import(`${root}public/shared/bookmarks.v${version}.js`);
const { createBookmarkSync, RETRY_STEPS_MS, SYNC_DEBOUNCE_MS, SYNC_POLL_MS, SYNC_REFRESH_MS } = await import(`${root}public/shared/bookmark-sync.v${version}.js`);
const read = (relative) => readFileSync(`${root}${relative}`, 'utf8');
const app = read(`public/reader/app.v${version}.js`);
const html = read('public/index.html');

function fakeStorage() {
  const data = new Map();
  return { data, getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => { data.set(k, String(v)); } };
}
const clock = (start = Date.UTC(2026, 10, 21, 8, 0, 0)) => { let time = start; const now = () => time; now.advance = (ms) => { time += ms; }; return now; };
const snap = (title) => ({ title, summary: `چکیدهٔ ${title}` });

// ---------- the local store: merging what the server answered ----------

test('merging the server\'s answer: the newest change wins, a tie keeps the local record, a bookmark from another device starts without a copy of the news', () => {
  const now = clock();
  const store = createBookmarkStore({ storage: fakeStorage(), now });
  store.add(1, snap('یک'));
  store.add(2, snap('دو'));
  const local = Object.fromEntries(store.records().map((r) => [r.id, r]));
  const kinds = [];
  store.subscribe(({ kind }) => kinds.push(kind));
  const result = store.mergeRemote([
    { newsId: 1, savedAt: local[1].savedAt, deletedAt: null, updatedAt: local[1].savedAt }, // the same: nothing to do
    { newsId: 2, savedAt: local[2].savedAt, deletedAt: local[2].savedAt + 5000 }, // removed on another device, later
    { newsId: 3, savedAt: local[2].savedAt + 9000, deletedAt: null }, // saved on another device
    { newsId: 4, savedAt: local[2].savedAt - 9000, deletedAt: local[2].savedAt - 8000 }, // a removal of something never saved here
  ]);
  assert.equal(result.changed, true);
  assert.deepEqual(kinds, ['merge'], 'one notice, and it says this came from the server');
  assert.deepEqual(store.list().map((r) => r.id).sort(), [1, 3]);
  assert.equal(store.has(2), false);
  assert.equal(store.list().find((r) => r.id === 3).snap.title, undefined, 'no copy of the news yet');
  assert.equal(store.list().find((r) => r.id === 1).snap.title, 'یک', 'the local copy is kept');
  assert.equal(store.records().find((r) => r.id === 2).snap, undefined, 'a tombstone carries no copy');

  const again = store.mergeRemote([{ newsId: 3, savedAt: local[2].savedAt + 9000, deletedAt: null }]);
  assert.equal(again.changed, false);
  assert.deepEqual(kinds, ['merge'], 'nothing changed, nobody told');
  const older = store.mergeRemote([{ newsId: 1, savedAt: 5, deletedAt: 6 }]); // an older removal
  assert.equal(older.changed, false);
  assert.equal(store.has(1), true);
});

test('merging ignores malformed records and survives a reload', () => {
  const storage = fakeStorage();
  const store = createBookmarkStore({ storage, now: clock() });
  const result = store.mergeRemote([null, {}, { newsId: 'x', savedAt: 5 }, { newsId: 3, savedAt: 'soon' }, { newsId: -1, savedAt: 5 }, { newsId: 7, savedAt: 1234 }]);
  assert.equal(result.changed, true);
  assert.deepEqual(store.list().map((r) => r.id), [7]);
  assert.equal(store.mergeRemote('nonsense').changed, false);
  assert.deepEqual(createBookmarkStore({ storage, now: clock() }).list().map((r) => r.id), [7], 'it was written to the storage');
});

test('a bookmark without a copy of its news is found, filled in once, and never overwritten', () => {
  const store = createBookmarkStore({ storage: fakeStorage(), now: clock() });
  store.add(1, snap('محلی'));
  store.mergeRemote([{ newsId: 2, savedAt: 5000, deletedAt: null }, { newsId: 3, savedAt: 6000, deletedAt: null }]);
  assert.deepEqual(store.needSnapshots().sort(), [2, 3]);
  assert.deepEqual(store.needSnapshots(new Set([3])), [2], 'those the server could not give are skipped');
  const kinds = [];
  store.subscribe(({ kind }) => kinds.push(kind));
  const changed = store.setSnaps(new Map([[2, { title: 'خبر دو', summary: 'چکیده' }], [1, { title: 'نباید جایگزین شود' }], [99, { title: 'ناشناخته' }], [3, {}]]));
  assert.equal(changed.changed, true);
  assert.deepEqual(kinds, ['snap']);
  assert.equal(store.list().find((r) => r.id === 2).snap.title, 'خبر دو');
  assert.equal(store.list().find((r) => r.id === 1).snap.title, 'محلی', 'a copy that is already there stays');
  assert.deepEqual(store.needSnapshots(), [3], 'an empty copy does not count');
  assert.equal(store.setSnaps(new Map([[2, { title: 'دوباره' }]])).changed, false);
});

test('the store tells its listeners what kind of change it was', () => {
  const store = createBookmarkStore({ storage: fakeStorage(), now: clock() });
  const kinds = [];
  store.subscribe(({ kind }) => kinds.push(kind));
  store.add(1, snap('یک'));
  store.remove(1);
  store.reload();
  assert.deepEqual(kinds, ['local', 'local', 'reload']);
});

// ---------- the sync controller ----------

// The poll gets a delay of its own here, so it can be told from a retry (which may also be two minutes).
const POLL = 7_777_777;

function harness({ answers = [], pullAnswers = [], active = true } = {}) {
  const now = clock();
  const store = createBookmarkStore({ storage: fakeStorage(), now });
  const timers = [];
  const events = new EventEmitter();
  events.addEventListener = (type, handler) => events.on(type, handler);
  events.removeEventListener = (type, handler) => events.off(type, handler);
  const visibility = Object.assign(new EventEmitter(), { visibilityState: 'visible' });
  visibility.addEventListener = (type, handler) => visibility.on(type, handler);
  visibility.removeEventListener = (type, handler) => visibility.off(type, handler);
  const log = { sent: [], pulled: 0, unauthorized: 0, disabled: 0, merged: 0 };
  const state = { active };
  const queue = [...answers];
  const pullQueue = [...pullAnswers];
  const next = (list) => (list.length > 1 ? list.shift() : list[0]);
  const controller = createBookmarkSync({
    store,
    isActive: () => state.active,
    send: async (items) => {
      log.sent.push(items);
      const answer = (() => { const value = next(queue); return typeof value === 'function' ? value(items) : value; })();
      if (answer === 'network') throw new Error('Failed to fetch');
      return answer;
    },
    pull: async () => {
      log.pulled += 1;
      const value = next(pullQueue) ?? { status: 200, body: { items: [] } };
      if (value === 'network') throw new Error('Failed to fetch');
      return typeof value === 'function' ? value() : value;
    },
    onUnauthorized: () => { log.unauthorized += 1; },
    onDisabled: () => { log.disabled += 1; },
    onMerged: () => { log.merged += 1; },
    clock: now,
    pollMs: POLL,
    schedule: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; },
    cancel: (timer) => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); },
    events,
    visibility,
  });
  // The timers that are not the two-minute poll (that one has its own tests).
  const pending = () => timers.filter((timer) => timer.delay !== POLL);
  // Runs the pending timer that is due first and waits for the sync it starts.
  const fire = async () => {
    const [timer] = pending().sort((a, b) => a.delay - b.delay);
    timers.splice(timers.indexOf(timer), 1);
    await timer.fn();
    return timer.delay;
  };
  // Runs the poll's timer the way a clock would: it is gone from the list once it has fired.
  const firePoll = async () => {
    const timer = timers.find((candidate) => candidate.delay === POLL);
    timers.splice(timers.indexOf(timer), 1);
    await timer.fn();
  };
  return { store, controller, timers, events, visibility, log, state, fire, firePoll, now, get pending() { return pending(); } };
}
const OK = (items = []) => ({ status: 200, body: { items } });

test('the sync sends everything the device has, tombstones included, and takes in the answer', async () => {
  const h = harness({ answers: [OK()] });
  h.store.add(1, snap('یک'));
  h.store.add(2, snap('دو'));
  h.store.remove(2);
  const [one] = h.store.records().filter((r) => r.id === 1);
  h.controller.start();
  assert.equal(h.pending.length, 1);
  assert.equal(await h.fire(), 0, 'the first sync starts at once');
  assert.equal(h.log.sent.length, 1);
  assert.deepEqual(h.log.sent[0].map((i) => [i.newsId, i.deletedAt === null]).sort(), [[1, true], [2, false]]);
  assert.deepEqual(Object.keys(h.log.sent[0][0]).sort(), ['deletedAt', 'newsId', 'savedAt'], 'the copy of the news never leaves the device');
  assert.equal(h.log.merged, 1);
  h.log.sent.length = 0;

  const h2 = harness({ answers: [OK([{ newsId: 7, savedAt: one.savedAt + 1000, deletedAt: null, updatedAt: one.savedAt + 1000 }, { newsId: 1, savedAt: one.savedAt, deletedAt: one.savedAt + 2000, updatedAt: one.savedAt + 2000 }])] });
  h2.store.add(1, snap('یک'));
  h2.controller.start();
  await h2.fire();
  assert.deepEqual(h2.store.list().map((r) => r.id), [7], 'the other device\'s bookmark came, and the one it removed went');
});

test('a local change starts a sync after two seconds; many changes make one; taking in the server\'s answer starts none', async () => {
  const h = harness({ answers: [OK()] });
  h.controller.start();
  await h.fire();
  assert.equal(h.pending.length, 0);
  h.store.add(1, snap('یک'));
  h.store.add(2, snap('دو'));
  h.store.remove(1);
  assert.equal(h.pending.length, 1, 'one sync is planned, not three');
  assert.equal(h.pending[0].delay, SYNC_DEBOUNCE_MS);
  await h.fire();
  assert.deepEqual(h.log.sent.at(-1).map((i) => i.newsId).sort(), [1, 2]);
  h.store.mergeRemote([{ newsId: 5, savedAt: 9999, deletedAt: null }]);
  h.store.setSnaps(new Map([[5, snap('پنج')]]));
  h.store.reload();
  assert.equal(h.pending.length, 0, 'the server\'s own changes are not sent back');
});

test('a failed sync loses nothing and is retried later with growing pauses, up to ten minutes; a success starts over', async () => {
  const h = harness({ answers: ['network', 'network', { status: 500, body: {} }, 'network', 'network', 'network', OK()] });
  h.store.add(1, snap('یک'));
  h.controller.start();
  const delays = [];
  for (let i = 0; i < 6; i += 1) { await h.fire(); delays.push(h.pending[0].delay); }
  assert.deepEqual(delays, [30_000, 60_000, 120_000, 300_000, 600_000, 600_000]);
  assert.deepEqual(RETRY_STEPS_MS, [30_000, 60_000, 120_000, 300_000, 600_000]);
  assert.deepEqual(h.store.list().map((r) => r.id), [1], 'the local bookmark is still there');
  await h.fire();
  assert.equal(h.pending.length, 0, 'the seventh try worked: nothing more is planned');
  h.answers = null;
  h.store.add(2, snap('دو'));
  assert.equal(h.pending[0].delay, SYNC_DEBOUNCE_MS);
});

test('no session or accounts switched off: no retry; nothing is sent while the sync is not active', async () => {
  const unauthorized = harness({ answers: [{ status: 401, body: {} }] });
  unauthorized.controller.start();
  await unauthorized.fire();
  assert.deepEqual([unauthorized.log.unauthorized, unauthorized.pending.length], [1, 0]);
  const disabled = harness({ answers: [{ status: 403, body: { code: 'disabled' } }] });
  disabled.controller.start();
  await disabled.fire();
  assert.deepEqual([disabled.log.disabled, disabled.pending.length], [1, 0]);
  const inactive = harness({ answers: [OK()], active: false });
  inactive.store.add(1, snap('یک'));
  inactive.controller.start();
  await inactive.fire();
  assert.equal(inactive.log.sent.length, 0, 'a reader who is signed out sends nothing');
  const odd = harness({ answers: [{ status: 200, body: { items: 'x' } }] });
  odd.controller.start();
  await odd.fire();
  assert.equal(odd.pending[0].delay, 30_000, 'an answer that makes no sense is a failure');
});

test('a change made while a sync is out is sent by the next one', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = harness({ answers: [async () => { await gate; return OK(); }, OK()] });
  h.controller.start();
  const first = h.fire();
  h.store.add(1, snap('یک'));
  h.timers.sort((a, b) => a.delay - b.delay);
  const during = h.timers.shift(); // the debounced sync (the earliest) fires while the first is still out
  await during.fn();
  assert.equal(h.log.sent.length, 1, 'only one at a time');
  release();
  await first;
  assert.equal(h.pending.length, 1, 'and another one is planned');
  await h.fire();
  assert.equal(h.log.sent.length, 2);
  assert.deepEqual(h.log.sent[1].map((i) => i.newsId), [1]);
});

test('it syncs when the connection comes back and when the page is shown again after a while, and stops completely when told to', async () => {
  const h = harness({ answers: [OK()] });
  h.controller.start();
  await h.fire();
  h.events.emit('online');
  assert.equal(h.pending[0].delay, 1000);
  await h.fire();
  h.visibility.emit('visibilitychange');
  assert.equal(h.pending.length, 0, 'shown again soon after a sync: nothing to do');
  h.now.advance(SYNC_REFRESH_MS + 1000);
  h.visibility.visibilityState = 'hidden';
  h.visibility.emit('visibilitychange');
  assert.equal(h.pending.length, 0, 'hidden: nothing');
  h.visibility.visibilityState = 'visible';
  h.visibility.emit('visibilitychange');
  assert.equal(h.pending[0].delay, 500);
  h.controller.stop();
  assert.equal(h.timers.length, 0, 'the poll is cancelled too');
  h.store.add(1, snap('یک'));
  h.events.emit('online');
  h.visibility.emit('visibilitychange');
  assert.equal(h.pending.length, 0, 'stopped means stopped');
  h.controller.start();
  assert.equal(h.pending.length, 1, 'and it can start again');
});

test('with nothing new to send the server\'s list is only fetched, and it still brings in what another device did', async () => {
  const h = harness({ answers: [OK()], pullAnswers: [{ status: 200, body: { items: [{ newsId: 9, savedAt: 5000, deletedAt: null }] } }] });
  h.controller.start();
  await h.fire(); // the first sync always sends
  assert.deepEqual([h.log.sent.length, h.log.pulled], [1, 0]);
  h.controller.syncNow();
  await h.fire();
  assert.deepEqual([h.log.sent.length, h.log.pulled], [1, 1], 'clean: a fetch, not an upload');
  assert.deepEqual(h.store.list().map((r) => r.id), [9], 'the other device\'s bookmark arrived');
  h.store.add(1, snap('یک'));
  await h.fire();
  assert.deepEqual([h.log.sent.length, h.log.pulled], [2, 1], 'a local change goes back to a full sync');
  h.controller.syncNow();
  await h.fire();
  assert.deepEqual([h.log.sent.length, h.log.pulled], [2, 2], 'and once it went through, fetching again');
});

test('a change made while only a fetch was out is not forgotten: the next sync sends it', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = harness({ answers: [OK(), OK()], pullAnswers: [async () => { await gate; return OK(); }] });
  h.controller.start();
  await h.fire();
  h.controller.syncNow();
  const fetching = h.fire();
  h.store.add(1, snap('یک'));
  release();
  await fetching;
  await h.fire();
  assert.equal(h.log.sent.length, 2, 'the new bookmark was uploaded');
  assert.deepEqual(h.log.sent[1].map((i) => i.newsId), [1]);
});

test('an open page asks the server every two minutes while it is visible, and not while it is in the background', async () => {
  const h = harness({ answers: [OK()] });
  h.controller.start();
  const polls = () => h.timers.filter((timer) => timer.delay === POLL);
  assert.equal(polls().length, 1, 'a poll is planned');
  assert.equal(SYNC_POLL_MS, 120_000, 'and in real life it is every two minutes');
  await h.fire();
  await h.firePoll();
  assert.equal(h.pending.length, 1, 'visible: a sync is planned');
  assert.equal(h.pending[0].delay, 0);
  assert.equal(polls().length, 1, 'and the next poll is already planned');
  await h.fire();
  assert.equal(h.log.pulled, 1, 'with nothing to send it is a fetch');
  h.visibility.visibilityState = 'hidden';
  await h.firePoll();
  assert.equal(h.pending.length, 0, 'hidden: no request');
  assert.equal(polls().length, 1, 'but the poll goes on');
  h.controller.stop();
  assert.equal(h.timers.length, 0);
});

test('a window that gets the reader\'s attention again syncs if it has been a while, like a tab that becomes visible', async () => {
  const h = harness({ answers: [OK()] });
  h.controller.start();
  await h.fire();
  h.events.emit('focus');
  assert.equal(h.pending.length, 0, 'just synced: nothing to do');
  h.now.advance(SYNC_REFRESH_MS + 1000);
  h.events.emit('focus');
  assert.equal(h.pending[0].delay, 500);
  assert.equal(SYNC_REFRESH_MS, 20_000);
});

// ---------- wired into the reader ----------

test('the reader syncs for a signed-in reader whatever the signup switch says, loads it lazily, and stops it when nobody is signed in', () => {
  assert.match(app, new RegExp(`import\\('/shared/bookmark-sync\\.v${version.replaceAll('.', '\\.')}\\.js'\\)`));
  assert.ok(!/^import .*bookmark-sync/m.test(app), 'not loaded at the start');
  assert.match(app, /isActive: \(\) => Boolean\(readerUser\)/);
  assert.ok(!/isActive:[^\n]*signup_enabled/.test(app), 'switching signup off does not stop a signed-in reader\'s sync');
  assert.match(app, /if \(signedIn\) startBookmarkSync\(\);\s*else stopBookmarkSync\(\);/);
  assert.match(app, /fetchOrExplain\('\/api\/reader\/bookmarks\/sync', \{\s*method: 'POST'/);
  assert.match(app, /pull: async \(\) => \{\s*const response = await fetchOrExplain\('\/api\/reader\/bookmarks', \{ headers: \{ accept: 'application\/json' \} \}\);/);
  assert.match(app, /onUnauthorized: \(\) => \{ readerUser = null; syncAccountUi\(\); \}/);
  assert.ok(!app.includes('onDisabled: () => stopBookmarkSync()'));
  assert.match(app, /onMerged: \(\) => hydrateSavedSnapshots\(\)/);
  assert.match(app, /hydrateSavedSnapshots\(\);\s*bookmarkSync\?\.then\(\(controller\) => controller\.syncNow\(\)\)/, 'opening the saved list refreshes it');
});

test('bookmarks from other devices get their titles from the server: 40 at a time, retried never for news it does not give back', () => {
  assert.match(app, /getJson\(`\/api\/public\/news-snapshots\?ids=\$\{ids\.join\(','\)\}`\)/);
  assert.match(app, /bookmarks\.needSnapshots\(unavailableSnapshots\)\.slice\(0, 40\)/);
  assert.match(app, /for \(const id of ids\) if \(!given\.has\(id\)\) unavailableSnapshots\.add\(id\)/);
  assert.match(app, /savedButton\.addEventListener\('click', \(\) => \{\s*renderSaved\(\);\s*savedDialog\.showModal\(\);\s*hydrateSavedSnapshots\(\);/);
});

test('the saved list says where the bookmarks live, and invites a signed-out reader to sign in when accounts are on', () => {
  assert.match(app, /'با حساب شما در همهٔ دستگاه‌ها همگام می‌شود\.'/);
  assert.match(app, /savedLogin\.hidden = !\(accountsOn && !readerUser\)/);
  assert.match(app, /savedLogin\.addEventListener\('click', \(\) => \{\s*savedDialog\.close\(\);\s*accountButton\.click\(\);/);
  assert.match(html, /<button class="account-link saved-login" id="saved-login" type="button" hidden>/);
});

// ---------- the public snapshots of news ----------

async function withPublic(rows, run) {
  const queries = [];
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql: sql.replace(/\s+/g, ' '), params });
      if (/FROM news n LEFT JOIN attachments cover/.test(sql)) return [rows, []];
      return [[], []];
    },
    execute: async () => [[], []],
  };
  const server = http.createServer(express().use(createPublicRouter({ pool, config: { publicUrl: 'https://news.example.ir' }, events: new EventEmitter(), staticAssets: null })));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const call = (path) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: text ? JSON.parse(text) : null }));
    }).on('error', reject);
  });
  try { return await run({ call, queries }); } finally { server.close(); server.closeAllConnections?.(); }
}

test('news-snapshots: a few lines about each requested news a reader may see, and nothing else', async () => {
  const rows = [{ id: 7, title: 'عنوان', summary: 'چکیده', news_type: 'news', published_at: new Date('2026-11-01T08:00:00Z'), publisher_unit: 'دانشگاه پیام‌نور بیجار', source_url: null, source_image_url: null, cover_stored_name: null, cover_dominant_color: null }];
  await withPublic(rows, async ({ call, queries }) => {
    const answer = await call('/api/public/news-snapshots?ids=7,%207,8,x,0,7');
    assert.equal(answer.status, 200);
    assert.deepEqual(queries.at(-1).params, [[7, 8]], 'duplicates and bad ids are dropped');
    assert.match(queries.at(-1).sql, /n\.status = 'published'/);
    assert.match(queries.at(-1).sql, /n\.deleted_at IS NULL/);
    assert.match(queries.at(-1).sql, /n\.expires_at IS NULL OR n\.expires_at > UTC_TIMESTAMP\(\)/);
    assert.match(queries.at(-1).sql, /EXISTS \(SELECT 1 FROM news_targets/);
    assert.deepEqual(Object.keys(answer.json.items[0]).sort(), ['cover', 'id', 'published_at', 'publisher_unit', 'source_url', 'summary', 'title']);
    assert.equal(answer.json.items[0].published_at, '2026-11-01T08:00:00.000Z');
    assert.equal(typeof answer.json.items[0].cover.src, 'string', 'a news without a picture gets the default cover');
    assert.ok(!JSON.stringify(answer.json).includes('body'), 'no article text');
    assert.match(answer.headers['cache-control'], /public/);
    for (const path of ['/api/public/news-snapshots', '/api/public/news-snapshots?ids=', '/api/public/news-snapshots?ids=x,y', `/api/public/news-snapshots?ids=${Array.from({ length: 41 }, (_, i) => i + 1).join(',')}`]) {
      assert.equal((await call(path)).status, 400, path);
    }
    assert.equal((await call(`/api/public/news-snapshots?ids=${Array.from({ length: 40 }, (_, i) => i + 1).join(',')}`)).status, 200, '40 is allowed');
  });
});
