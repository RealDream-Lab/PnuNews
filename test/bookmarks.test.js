import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(`${root}package.json`, 'utf8')).version;
const html = readFileSync(`${root}public/index.html`, 'utf8');
const script = readFileSync(`${root}public/reader/app.v${version}.js`, 'utf8');
const styles = readFileSync(`${root}public/reader/styles.v${version}.css`, 'utf8');
const worker = readFileSync(`${root}public/sw.js`, 'utf8');
const { BOOKMARKS_KEY, MAX_BOOKMARKS, TOMBSTONE_TTL_MS, createBookmarkStore, snapFromItem, updatedAt } = await import(`${root}public/shared/bookmarks.v${version}.js`);

// A Storage stand-in. `fail` makes every write throw like a blocked or full browser storage.
function fakeStorage({ fail = false } = {}) {
  const data = new Map();
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => {
      if (fail) throw new Error('QuotaExceededError');
      data.set(key, String(value));
    },
  };
}

function clock(start = 1_000_000) {
  let time = start;
  const now = () => time;
  now.advance = (ms) => { time += ms; };
  return now;
}

test('saved news are listed newest first and counted', () => {
  const now = clock();
  const store = createBookmarkStore({ storage: fakeStorage(), now });
  store.add(7, { title: 'خبر هفت' });
  now.advance(10);
  store.add(3, { title: 'خبر سه' });
  assert.equal(store.count(), 2);
  assert.deepEqual(store.list().map((record) => record.id), [3, 7]);
  assert.equal(store.has(7), true);
  assert.equal(store.has('3'), true, 'ids may come from a data attribute (strings)');
  assert.equal(store.has(99), false);
});

test('adding the same news twice keeps one bookmark and its first save time', () => {
  const now = clock();
  const store = createBookmarkStore({ storage: fakeStorage(), now });
  store.add(5, { title: 'الف' });
  const first = store.list()[0].savedAt;
  now.advance(500);
  const result = store.add(5, { title: 'ب' });
  assert.equal(result.ok, true);
  assert.equal(store.count(), 1);
  assert.equal(store.list()[0].savedAt, first);
});

test('removing leaves a tombstone that the sync can see, and drops the local copy of the news', () => {
  const now = clock();
  const store = createBookmarkStore({ storage: fakeStorage(), now });
  store.add(5, { title: 'الف', cover: '/x.jpg' });
  now.advance(50);
  store.remove(5);
  assert.equal(store.has(5), false);
  assert.equal(store.count(), 0);
  assert.deepEqual(store.list(), []);
  const [tombstone] = store.records();
  assert.equal(tombstone.id, 5);
  assert.ok(tombstone.deletedAt > tombstone.savedAt);
  assert.equal(tombstone.snap, undefined);
  assert.equal(updatedAt(tombstone), tombstone.deletedAt);
});

test('saving again right after removing is newer than the tombstone, even within the same millisecond', () => {
  const store = createBookmarkStore({ storage: fakeStorage(), now: () => 5_000 });
  store.add(9, { title: 'خبر' });
  store.remove(9);
  const removedAt = store.records()[0].deletedAt;
  store.add(9, { title: 'خبر' });
  const [record] = store.records();
  assert.equal(record.deletedAt, null);
  assert.ok(record.savedAt > removedAt, 'the new save wins the last-change-wins comparison');
  assert.equal(store.has(9), true);
});

test('toggle saves, then removes', () => {
  const store = createBookmarkStore({ storage: fakeStorage(), now: clock() });
  assert.equal(store.toggle(4, { title: 'خبر' }).saved, true);
  assert.equal(store.has(4), true);
  assert.equal(store.toggle(4).saved, false);
  assert.equal(store.has(4), false);
});

test('there is a limit of live bookmarks; removed ones do not count and a full list still allows removing', () => {
  const store = createBookmarkStore({ storage: fakeStorage(), now: clock(), max: 3 });
  for (const id of [1, 2, 3]) assert.equal(store.add(id, { title: `خبر ${id}` }).ok, true);
  const refused = store.add(4, { title: 'خبر ۴' });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'limit');
  assert.equal(store.has(4), false);
  store.remove(2);
  assert.equal(store.add(4, { title: 'خبر ۴' }).ok, true);
  assert.equal(MAX_BOOKMARKS, 500);
});

test('invalid ids are refused', () => {
  const store = createBookmarkStore({ storage: fakeStorage(), now: clock() });
  for (const id of [0, -1, 'abc', null, undefined, 1.5]) assert.equal(store.add(id, {}).ok, false, String(id));
  assert.equal(store.count(), 0);
});

test('bookmarks survive a reload from the same storage', () => {
  const storage = fakeStorage();
  const now = clock();
  const first = createBookmarkStore({ storage, now });
  first.add(11, { title: 'خبر', unit: 'دانشگاه پیام‌نور بیجار' });
  const second = createBookmarkStore({ storage, now });
  assert.equal(second.has(11), true);
  assert.equal(second.list()[0].snap.unit, 'دانشگاه پیام‌نور بیجار');
});

test('a corrupted or foreign storage value is ignored instead of breaking the reader', () => {
  for (const bad of ['not json', '{"items":"x"}', '[1,2,3]', '{"items":[null,{"id":"x"},{"id":3},{"id":4,"savedAt":"soon"}]}']) {
    const storage = fakeStorage();
    storage.data.set(BOOKMARKS_KEY, bad);
    const store = createBookmarkStore({ storage, now: clock() });
    assert.equal(store.count(), 0, bad);
    assert.equal(store.add(1, { title: 'خبر' }).ok, true);
  }
});

test('storage that refuses writes keeps the bookmarks in memory and reports it', () => {
  const store = createBookmarkStore({ storage: fakeStorage({ fail: true }), now: clock() });
  assert.equal(store.add(2, { title: 'خبر' }).ok, true);
  assert.equal(store.has(2), true);
  assert.equal(store.persistent, false);
  const none = createBookmarkStore({ storage: null, now: clock() });
  none.add(1, { title: 'خبر' });
  assert.equal(none.has(1), true);
  assert.equal(none.persistent, false);
});

test('tombstones older than 90 days are forgotten, recent ones are kept', () => {
  const storage = fakeStorage();
  const now = clock(10 * TOMBSTONE_TTL_MS);
  const store = createBookmarkStore({ storage, now });
  store.add(1, { title: 'قدیمی' });
  store.add(2, { title: 'تازه' });
  store.remove(1);
  now.advance(TOMBSTONE_TTL_MS - 1000);
  store.remove(2);
  now.advance(2000);
  const later = createBookmarkStore({ storage, now });
  assert.deepEqual(later.records().map((record) => record.id), [2], 'the old tombstone is gone, the recent one stays');
});

test('a change made in another tab is picked up by reload and by the next change', () => {
  const storage = fakeStorage();
  const now = clock();
  const tabA = createBookmarkStore({ storage, now });
  const tabB = createBookmarkStore({ storage, now });
  tabA.add(1, { title: 'یک' });
  tabB.add(2, { title: 'دو' });
  assert.deepEqual(tabB.list().map((record) => record.id).sort(), [1, 2], 'tab B built on what tab A had written');
  let notified = 0;
  tabA.subscribe(() => { notified += 1; });
  tabA.reload();
  assert.equal(notified, 1);
  assert.equal(tabA.has(2), true);
});

test('listeners are told about real changes only, and can unsubscribe', () => {
  const store = createBookmarkStore({ storage: fakeStorage(), now: clock() });
  let calls = 0;
  const stop = store.subscribe(() => { calls += 1; });
  store.add(1, { title: 'خبر' });
  store.add(1, { title: 'خبر' }); // already saved
  store.remove(8); // never saved
  assert.equal(calls, 1);
  stop();
  store.remove(1);
  assert.equal(calls, 1);
});

test('the local copy keeps only short text fields of a news item', () => {
  const snap = snapFromItem({
    id: 1,
    title: `  ${'ع'.repeat(500)}  `,
    summary: 'نباید ذخیره شود',
    body_html: '<p>نباید ذخیره شود</p>',
    cover: { src: '/media/a.jpg', dominant_color: '#112233', srcset: 'x' },
    published_at: '2026-11-01T08:00:00.000Z',
    publisher_unit: 'دانشگاه پیام‌نور بیجار',
    source_url: 'https://pnu.ac.ir/x',
    view_count: 12,
  });
  assert.equal(snap.title.length, 240);
  assert.deepEqual(Object.keys(snap).sort(), ['color', 'cover', 'publishedAt', 'sourceUrl', 'title', 'unit']);
  assert.deepEqual(snapFromItem({ id: 2 }), {}, 'a bare item gives an empty copy');
});

test('the reader wires bookmarks into the page, the cards, the news page and the service worker', () => {
  assert.match(html, /id="icon-bookmark"/);
  assert.match(html, /<button[^>]*id="saved-button"[^>]*aria-controls="saved-dialog"[^>]*aria-label="[^"]+"/);
  assert.match(html, /<dialog id="saved-dialog"[^>]*aria-labelledby="saved-title"/);
  assert.match(html, /id="saved-list"/);
  assert.match(script, new RegExp(`from '/shared/bookmarks\\.v${version.replaceAll('.', '\\.')}\\.js'`));
  assert.match(script, /data-save-card/);
  assert.match(script, /data-save-page/);
  assert.equal(script.split('${cardSaveMarkup(item)}${cardShareMarkup()}').length - 1, 4, 'every card layout has the bookmark button before the share button');
  assert.match(script, /bookmarks\.subscribe\(syncSavedUi\)/);
  assert.match(script, /window\.addEventListener\('storage'/);
  assert.match(worker, new RegExp(`/shared/bookmarks\\.v${version.replaceAll('.', '\\.')}\\.js`));
  assert.match(styles, /\.card-save\{/);
  assert.match(styles, /\.saved-dialog\{/);
});

test('the bookmark and staff edit buttons do not sit on top of each other on a card with a cover', () => {
  const left = (selector) => Number(new RegExp(`${selector.replaceAll('.', '\\.')}\\{position:absolute;left:([\\d.]+)rem`).exec(styles)?.[1]);
  const share = Number(/\.card-meta-overlay \.card-share\{position:absolute;left:([\d.]+)rem/.exec(styles)?.[1]);
  const save = left('.card-meta-overlay .card-save');
  const edit = left('.card-meta-overlay .card-edit');
  assert.ok(share < save && save < edit, `share ${share} < save ${save} < edit ${edit}`);
  assert.ok(save - share >= 1.8 && edit - save >= 1.8, 'each 26px button has room');
});

test('on phones the settings button moves to the second row so the saved-news button leaves room for the site name', () => {
  const phones = /@media\(max-width:639px\)\{([\s\S]*?)\n\}/.exec(styles)?.[1] ?? '';
  const order = (selector) => Number(new RegExp(`${selector.replaceAll('.', '\\.')}\\{order:(\\d+)`).exec(phones)?.[1]);
  assert.ok(order('#settings-button') > order('.font-controls'), 'settings comes after the font buttons, at the end of row 2');
  assert.ok(order('.font-controls') > order('.search-button') && order('.search-button') > order('.city-button'));
  assert.ok(order('#settings-button') > 9, 'after the line break item (order 9), so it is on the second row');
  assert.match(phones, /#settings-button\{order:13;margin-top:\.4rem\}/);
  assert.doesNotMatch(phones, /\.saved-button\{order/, 'the saved-news button stays in the first row');
  assert.ok(html.indexOf('id="saved-button"') < html.indexOf('id="settings-button"'));
});

