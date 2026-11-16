import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(`${root}package.json`, 'utf8')).version;
const html = readFileSync(`${root}public/index.html`, 'utf8');
const script = readFileSync(`${root}public/reader/app.v${version}.js`, 'utf8');
const styles = readFileSync(`${root}public/reader/styles.v${version}.css`, 'utf8');

test('the home page has a scroll-to-top button that starts hidden', () => {
  assert.match(html, /<button[^>]*id="scroll-top"[^>]*class="scroll-top"[^>]*aria-label="[^"]+"[^>]*hidden>/);
  assert.match(html, /<symbol id="icon-arrow-up"/);
  assert.ok(html.includes('href="#icon-arrow-up"'));
});

test('the button shows only on the home feed after scrolling, and glides back to the top', () => {
  assert.match(script, /getElementById\('scroll-top'\)/);
  assert.match(script, /button\.hidden = app\.hidden \|\| window\.scrollY < SHOW_AFTER/);
  assert.match(script, /attributeFilter: \['hidden'\]/, 'it must hide when an article replaces the feed');
  assert.match(script, /button\.addEventListener\('click', \(\) => \{ glideToTop\(\); \}\)/);
});

test('the button floats above the radio dock on the reader\'s end side', () => {
  assert.match(styles, /\.scroll-top\{position:fixed;[^}]*inset-inline-end:[^}]*bottom:calc\(max\(var\(--dock-height,0px\),var\(--safe-bottom,0px\)\) \+ \.75rem\)/);
});

test('the glide survives cards being rebuilt above the reader and trackpad momentum', () => {
  const restore = script.slice(script.indexOf('function restoreRecycled'), script.indexOf('An IntersectionObserver only reports'));
  assert.match(restore, /glideShiftHook\?\.\(shift\)/, 'scroll corrections made by the card restore are reported to a running glide');
  const glide = script.slice(script.indexOf('function glideToTop'), script.indexOf("newItemsBanner.addEventListener('click'"));
  assert.match(glide, /glideShiftHook = \(shift\) => \{ offset \+= shift; \}/);
  assert.match(glide, /const onWheel = \(event\) => \{ if \(event\.deltaY > 0\) event\.preventDefault\(\); \}/, 'momentum wheel events are swallowed instead of cancelling the glide');
  assert.match(glide, /addEventListener\('wheel', onWheel, \{ passive: false \}\)/);
  assert.doesNotMatch(glide, /Math\.abs\(window\.scrollY - lastY\)/, 'a position difference is never read as the reader grabbing the page');
  assert.match(glide, /SETTLE_MS/, 'the top is held for a moment after arriving');
});
