import assert from 'node:assert/strict';
import test from 'node:test';
import { CLOCK_SKEW_MS, MAX_SYNC_ITEMS, TOMBSTONE_TTL_MS, mergeBookmarks, parseSyncItems } from '../src/lib/bookmark-merge.js';

const NOW = Date.UTC(2026, 10, 21, 8, 0, 0);
// Small numbers stand for «a little after T0», an hour before now: realistic times, easy to read.
const T0 = NOW - 3600_000;
const rec = (newsId, savedAt, deletedAt = null) => ({ newsId, savedAt: T0 + savedAt, deletedAt: deletedAt === null ? null : T0 + deletedAt, updatedAt: T0 + (deletedAt ?? savedAt) });
const item = (newsId, savedAt, deletedAt = null) => ({ newsId, savedAt: T0 + savedAt, deletedAt: deletedAt === null ? null : T0 + deletedAt });
const raw = (newsId, savedAt, deletedAt = null) => ({ newsId, savedAt, deletedAt }); // absolute times
const merge = (existing, incoming, extra = {}) => mergeBookmarks(existing, incoming, { now: NOW, ...extra });
const ids = (records, live = true) => records.filter((r) => (r.deletedAt === null) === live).map((r) => r.newsId).sort((a, b) => a - b);

test('the union of two devices: what only one has is kept, what both have takes the newest change', () => {
  const result = merge([rec(1, 100), rec(2, 200)], [item(2, 200), item(3, 300)]);
  assert.deepEqual(ids(result.records), [1, 2, 3]);
  assert.deepEqual(result.changed.map((r) => r.newsId), [3], 'only the new one is written');
});

test('a removal on one device is not undone by an older copy on another', () => {
  const server = [rec(5, 100, 400)]; // removed at 400
  const stale = merge(server, [item(5, 100)]); // another device still has the bookmark saved at 100
  assert.deepEqual(ids(stale.records), []);
  assert.equal(stale.records[0].deletedAt, T0 + 400);
  assert.deepEqual(stale.changed, []);
  const removedHere = merge([rec(5, 100)], [item(5, 100, 400)]);
  assert.deepEqual(ids(removedHere.records), []);
  assert.equal(removedHere.changed[0].deletedAt, T0 + 400);
});

test('saving again after a removal wins, even though the old tombstone is still around', () => {
  const server = [rec(5, 100, 400)];
  const revived = merge(server, [item(5, 401)]);
  assert.deepEqual(ids(revived.records), [5]);
  assert.equal(revived.records[0].deletedAt, null);
  assert.equal(revived.records[0].savedAt, T0 + 401);
});

test('a tie keeps what the server has', () => {
  const result = merge([rec(1, 100, 300)], [item(1, 100, 300), item(1, 300)]);
  assert.equal(result.records[0].deletedAt, T0 + 300);
  assert.deepEqual(result.changed, []);
  const same = merge([rec(2, 500)], [item(2, 500)]);
  assert.deepEqual(same.changed, []);
});

test('the oldest saved bookmarks are removed when there are more than the limit, and everyone learns of it as a tombstone', () => {
  const existing = [rec(1, 10), rec(2, 20), rec(3, 30)];
  const result = merge(existing, [item(4, 40), item(5, 50)], { cap: 3 });
  assert.deepEqual(ids(result.records), [3, 4, 5]);
  const removed = result.records.filter((r) => r.deletedAt !== null);
  assert.deepEqual(removed.map((r) => r.newsId).sort(), [1, 2]);
  for (const record of removed) {
    assert.equal(record.deletedAt, NOW);
    assert.equal(record.updatedAt, NOW);
    assert.ok(record.deletedAt > record.savedAt);
  }
  assert.deepEqual(result.changed.map((r) => r.newsId).sort(), [1, 2, 4, 5]);
  // the next sync of a device that still has 1 and 2 does not bring them back
  const again = merge(result.records, [item(1, 10), item(2, 20)], { cap: 3 });
  assert.deepEqual(ids(again.records), [3, 4, 5]);
});

test('tombstones older than 90 days are forgotten, in the database and in what a device sends', () => {
  const old = NOW - TOMBSTONE_TTL_MS - 1000;
  const result = merge([{ newsId: 1, savedAt: 10, deletedAt: old, updatedAt: old }, { newsId: 2, savedAt: 10, deletedAt: NOW - 1000, updatedAt: NOW - 1000 }], []);
  assert.deepEqual(result.records.map((r) => r.newsId), [2]);
  const parsed = parseSyncItems({ items: [raw(7, 10, old), raw(8, 10, NOW - 1000), raw(9, NOW - 5)] }, NOW);
  assert.deepEqual(parsed.items.map((i) => i.newsId).sort(), [8, 9]);
});

test('records come back newest change first', () => {
  const result = merge([rec(1, 100), rec(2, 300), rec(3, 200, 250)], []);
  assert.deepEqual(result.records.map((r) => r.newsId), [2, 3, 1]);
});

test('sync items are checked strictly; times are clamped to the clock; duplicates keep the newest', () => {
  for (const bad of [null, undefined, 5, 'x', {}, { items: 'x' }, { items: [null] }, { items: [5] }, { items: [{}] },
    { items: [raw('1', 10)] }, { items: [raw(0, 10)] }, { items: [raw(1.5, 10)] }, { items: [raw(1, -5)] }, { items: [raw(1, '10')] },
    { items: [raw(1, 10, 5)] }, { items: [raw(1, 10, 'x')] }, { items: [{ newsId: 1, savedAt: 10, deletedAt: 0 }] },
    { items: Array.from({ length: MAX_SYNC_ITEMS + 1 }, (_, i) => raw(i + 1, 10)) }]) {
    assert.ok(parseSyncItems(bad, NOW).error, JSON.stringify(bad)?.slice(0, 60));
  }
  assert.deepEqual(parseSyncItems({ items: [] }, NOW), { items: [] });
  assert.deepEqual(parseSyncItems({ items: [{ newsId: 1, savedAt: 10 }] }, NOW).items, [raw(1, 10)], 'a missing deletedAt means saved');
  const future = parseSyncItems({ items: [raw(1, NOW + 9 * 3600_000), raw(2, 10, NOW + 9 * 3600_000)] }, NOW);
  assert.equal(future.items[0].savedAt, NOW + CLOCK_SKEW_MS, 'a clock that runs ahead cannot win every later comparison');
  assert.equal(future.items[1].deletedAt, NOW + CLOCK_SKEW_MS);
  const dup = parseSyncItems({ items: [raw(1, 100), raw(1, 300), raw(1, 200)] }, NOW);
  assert.deepEqual(dup.items, [raw(1, 300)]);
  assert.equal(parseSyncItems({ items: Array.from({ length: MAX_SYNC_ITEMS }, (_, i) => raw(i + 1, 10)) }, NOW).items.length, MAX_SYNC_ITEMS);
});
