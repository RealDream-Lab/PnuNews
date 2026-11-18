import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(`${root}package.json`, 'utf8')).version;
const script = readFileSync(`${root}public/reader/app.v${version}.js`, 'utf8');
const styles = readFileSync(`${root}public/reader/styles.v${version}.css`, 'utf8');

test('the arrows beside the important/urgent strip scroll it while the mouse rests on them', () => {
  assert.match(script, /button\.addEventListener\('pointerenter', \(event\) => \{ if \(event\.pointerType !== 'touch'\) startHoverScroll\(step\); \}\)/);
  assert.match(script, /button\.addEventListener\('pointerleave', stopHoverScroll\)/);
  assert.match(script, /pinnedStrip\.scrollLeft \+= hoverStep \* pinnedDirection\(\) \* HOVER_SPEED \* ease \* dt/);
});

test('hover scrolling stops at the end of the strip and when the arrow disappears', () => {
  assert.match(script, /hoverStep > 0 \? position >= max - 1 : position <= 1\) \{ stopHoverScroll\(\); return; \}/);
  assert.match(script, /\(hoverStep < 0 && pinnedPrev\.hidden\) \|\| \(hoverStep > 0 && pinnedNext\.hidden\)\) stopHoverScroll\(\)/);
  assert.match(script, /addEventListener\('blur', stopHoverScroll\)/);
});

test('the speed does not depend on the screen refresh rate and a stalled frame cannot make it jump', () => {
  assert.match(script, /const dt = Math\.min\(now - hoverLast, 50\)/);
  assert.match(script, /const HOVER_SPEED = 0\.6;/);
});

test('a click or Enter still moves one step for the keyboard and for reduced motion, but a mouse click does not fight the hover', () => {
  assert.match(script, /if \(event\.detail === 0 \|\| !hoverScrolls\(\)\) scrollPinned\(step\)/);
  assert.match(script, /const hoverScrolls = \(\) => !reducedMotion\.matches/);
});

test('the arrows are still only shown for a mouse', () => {
  assert.match(styles, /@media\(hover:hover\) and \(pointer:fine\)\{\n\.pinned-nav:not\(\[hidden\]\)\{display:grid/);
});

test('the arrows use the site theme colours (as the scroll-to-top button does), not a fixed accent', () => {
  const rules = styles.split('\n').filter((line) => line.startsWith('.pinned-nav') || line.startsWith('.pinned-prev') || line.startsWith('.pinned-next')).join('\n');
  assert.match(rules, /\.pinned-nav:not\(\[hidden\]\)\{[^}]*border:1px solid var\(--border\)[^}]*background:var\(--surface\);color:var\(--primary\)/);
  assert.match(rules, /\.pinned-nav:hover\{[^}]*background:var\(--primary-soft\);border-color:var\(--primary\)/);
  assert.match(rules, /\.pinned-nav:focus-visible\{outline:2px solid var\(--primary\)/);
  assert.doesNotMatch(rules, /#[0-9a-f]{3,8}\b|rgba\(0,229,195/i, 'no hard-coded colour may come back');
});
