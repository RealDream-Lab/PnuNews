import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(`${root}package.json`, 'utf8')).version;
const read = (relative) => readFileSync(`${root}${relative}`, 'utf8');
const css = read(`public/reader/styles.v${version}.css`);

test('on a desktop with a mouse a hovered card lifts and gets a shadow instead of a frame', () => {
  assert.ok(!/\.news-card:hover\{border-color/.test(css), 'the frame on hover is gone');
  assert.ok(!/\.account-card:hover\{border-color/.test(css));
  const block = css.slice(css.indexOf('@media(hover:hover) and (pointer:fine){\n.news-card,.pinned-card,.account-card'));
  assert.match(block, /\.news-card:hover,\.pinned-card:hover,\.account-card:hover\{z-index:1;transform:translateY\(-4px\);box-shadow:var\(--lift-shadow\)\}/);
  assert.match(block, /transition:transform \.15s ease,box-shadow \.15s ease/, 'a short transition, at most 150 ms');
  assert.ok(!/@media\(hover:hover\)\{\.news-card:hover/.test(css), 'not for touch screens, where hover sticks after a tap');
});

test('the shadow has a version for both themes, and the strip leaves room so the lift is not clipped', () => {
  assert.match(css, /:root\[data-theme="dark"\]\{--lift-shadow:[^}]*rgba\(0,0,0,/);
  assert.match(css, /@media\(prefers-color-scheme:dark\)\{:root\[data-theme="auto"\]\{--lift-shadow:/);
  assert.match(css, /\.pinned-strip\{padding-top:\.5rem;margin-top:-\.4rem\}/);
});

test('the dashboard no longer has a statistics page: no menu item, no view, no loader, no icon, no unused query', () => {
  const dashboard = read(`public/dashboard/dashboard.v${version}.js`);
  const page = read('public/dashboard/index.html');
  assert.ok(!/data-view="stats"|stats-view|stats-counts|most-viewed|admin-icon-chart/.test(page));
  assert.ok(!/loadStats|"stats"|stats-counts|most-viewed/.test(dashboard));
  const admin = read('src/routes/admin.js');
  assert.ok(!/most_viewed|mostViewed/.test(admin));
  assert.match(admin, /router\.get\('\/stats'/, 'the dashboard home still reads its counts and latest news here');
});
