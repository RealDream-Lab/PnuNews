import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(`${root}package.json`, 'utf8')).version;
const app = readFileSync(`${root}public/reader/app.v${version}.js`, 'utf8');
const hint = app.slice(app.indexOf('const PINNED_HINT_OUT_MS'), app.indexOf("pinnedStrip.addEventListener('click', (event) => {"));

test('the top cards give one gentle hint when more of them are hidden: out, a short hold, back', () => {
  assert.ok(hint.length > 500, 'the hint code exists');
  assert.match(hint, /const PINNED_HINT_OUT_MS = 800;[\s\S]*PINNED_HINT_HOLD_MS = 250;[\s\S]*PINNED_HINT_BACK_MS = 800;/);
  assert.match(hint, /let pinnedHintDone = false;/);
  assert.match(hint, /function playPinnedHint\(\) \{\s*pinnedHintDone = true;/, 'it can only ever play once per page open');
  assert.match(hint, /if \(pinnedHintDone \|\| reducedMotion\.matches/, 'never for reduced motion, never twice');
  assert.match(hint, /pinnedStrip\.scrollLeft = expected \* direction;/, 'it follows the strip\'s own direction (negative in right-to-left)');
  assert.match(hint, /if \(elapsed >= total\) \{ stop\(\); return; \}/);
  assert.match(hint, /expected = elapsed >= total \? 0 : offsetAt\(elapsed\)/, 'it ends exactly where it started');
  assert.match(hint, /Math\.min\(max, Math\.max\(96, pinnedStrip\.clientWidth \* 0\.28\)\)/, 'a short glide, never past the end');
});

test('it runs only when it makes sense: something is hidden, the reader has not moved it, the page is ready and the strip is on screen', () => {
  assert.match(hint, /document\.hidden \|\| pinnedStrip\.hidden/);
  assert.match(hint, /document\.getElementById\('page-loader'\) \|\| document\.querySelector\('\.news-page'\)/, 'not under the loading layer, not on an article');
  assert.match(hint, /document\.querySelector\('dialog\[open\]'\)/);
  assert.match(hint, /if \(max < 24 \|\| position > 2\) return false;/, 'all the cards fit, or the reader already moved the strip');
  assert.match(hint, /box\.bottom > 0 && box\.top < innerHeight/);
  assert.match(hint, /setTimeout\(\(\) => \{ if \(pinnedHintReady\(\)\) playPinnedHint\(\);[\s\S]*?\}, 1200\)/, 'it waits for the strip to stop changing');
  assert.match(hint, /new MutationObserver\(schedulePinnedHint\)\.observe\(pinnedStrip/);
});

test('the reader always wins: a touch, wheel, key or any outside movement stops it at once and leaves the strip where they put it', () => {
  for (const type of ['pointerdown', 'touchstart', 'wheel', 'keydown']) assert.ok(hint.includes(`'${type}'`), type);
  assert.match(hint, /pinnedStrip\.addEventListener\(type, stop, \{ passive: true \}\)/);
  assert.match(hint, /pinnedStrip\.removeEventListener\(type, stop\)/);
  assert.match(hint, /Math\.abs\(Math\.abs\(pinnedStrip\.scrollLeft\) - expected\) > 3\) \{ stop\(\); return; \}/);
  assert.ok(!/scrollTo|scrollBy|behavior:/.test(hint), 'it does not use the browser\'s smooth scrolling (its speed cannot be controlled and it cannot be cancelled cleanly)');
});
