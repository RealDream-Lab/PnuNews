import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(`${root}package.json`, 'utf8')).version;
const script = readFileSync(`${root}public/reader/app.v${version}.js`, 'utf8');
const between = (start, end) => script.slice(script.indexOf(start), script.indexOf(end, script.indexOf(start)));

test('cards recycled off the top of the feed are remembered and rebuilt when the reader scrolls back up to the blank', () => {
  assert.match(script, /recycled: \[\]/);
  assert.match(between('function recycleFeed', 'const RESTORE_AHEAD'), /state\.recycled\.push\(\.\.\.removed\.map/);
  assert.match(between('function clearFeed', 'function resetFeed'), /state\.recycled = \[\]/);
  const restore = between('function restoreRecycled', 'An IntersectionObserver only reports');
  assert.match(restore, /state\.recycled\.splice\(-Math\.min\(state\.recycled\.length, RESTORE_BATCH\)\)/, 'the newest recycled cards come back first');
  assert.match(restore, /state\.spacer\.after\(/, 'rebuilt cards go right under the spacer, above the live ones');
  assert.match(restore, /state\.entries\.unshift\(/);
  assert.match(restore, /window\.scrollTo\(\{ top: window\.scrollY \+ shift, behavior: 'instant' \}\)/, 'a visible card anchors the page so it does not jump');
  assert.match(restore, /state\.spacer\.remove\(\)/, 'the spacer goes when nothing is left to restore');
  assert.match(script, /window\.addEventListener\('scroll', scheduleRestore, \{ passive: true \}\)/);
});

test('the feed preloads far enough ahead that a fast scroll does not outrun it', () => {
  assert.match(script, /rootMargin: '2200px 0px'/);
  const recycleAt = Number(/const excess = state\.entries\.length - (\d+)/.exec(script)[1]);
  assert.ok(recycleAt >= 60, 'the live window stays large enough that restoring never re-recycles at once');
});

test('the "new items" banner does not appear because cards were recycled off the top of a long feed', async () => {
  const { planLiveUpdate, itemSignature } = await import(`${root}public/shared/live-plan.v${version}.js`);
  const mk = (id) => ({ id, title: `t${id}`, summary: '', published_at: new Date(2026, 0, 100 - id).toISOString() });
  const firstPage = { items: [mk(1), mk(2), mk(3)], pinned: [], next_cursor: 'x' };
  const onScreen = [mk(4), mk(5)].map((item) => ({ id: item.id, item, sig: itemSignature(item) }));
  const recycled = [mk(1), mk(2), mk(3)].map((item) => ({ id: item.id, item, sig: itemSignature(item) }));
  assert.ok(planLiveUpdate(onScreen, firstPage).resync, 'without the recycled cards the comparison wrongly sees everything as new');
  const plan = planLiveUpdate([...recycled, ...onScreen], firstPage);
  assert.equal(plan.inserts.length, 0);
  assert.equal(plan.resync, false);
  const sync = script.slice(script.indexOf('async function syncFeed'), script.indexOf('function startLive'));
  assert.match(sync, /state\.recycled\.map\(\(\{ id, item \}\) => \(\{ id, item, sig: itemSignature\(item\) \}\)\)/, 'syncFeed counts the recycled cards as known');
  assert.match(sync, /planLiveUpdate\(known, data\)/);
});
