import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (file) => readFileSync(`${root}${file}`, 'utf8');
const version = JSON.parse(read('package.json')).version;
const html = read('public/index.html');
const css = read(`public/reader/styles.v${version}.css`);
const app = read(`public/reader/app.v${version}.js`);

test('the loading layer is the first thing in the page, announces itself and carries no inline style or script (CSP)', () => {
  const body = html.slice(html.indexOf('<body>'));
  assert.match(body, /^<body>\s*<div id="page-loader" class="page-loader" role="status" aria-live="polite">\s*<svg class="loader-spiral"/);
  assert.ok(/<span class="sr-only">در حال بارگذاری/.test(body));
  const layer = body.slice(0, body.indexOf('</div>') + 6);
  assert.ok(!/\sstyle=|\sonload=|<script/.test(layer));
  assert.ok(html.indexOf(`/reader/styles.v${version}.css`) < html.indexOf('<body>'), 'the stylesheet is in the head, so the layer is styled from the first paint');
});

test('the layer covers the page, fades out softly, lifts by itself after 12 s without script and respects reduced motion', () => {
  assert.match(css, /\.page-loader\{[^}]*position:fixed;inset:0;[^}]*z-index:1000[^}]*transition:opacity \.55s/);
  assert.match(css, /\.page-loader\.is-leaving\{opacity:0;visibility:hidden;pointer-events:none\}/);
  assert.match(css, /animation:loader-failsafe \.01s linear 12s forwards/);
  assert.match(css, /@keyframes loader-failsafe\{to\{opacity:0;visibility:hidden;pointer-events:none\}\}/);
  assert.match(css, /\.loader-spiral\{[^}]*animation:loader-spin 1\.15s linear infinite/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)\{\s*\.page-loader\{animation:loader-failsafe \.01s linear 12s forwards!important;[^}]*\}\s*\.loader-spiral\{animation:loader-breathe[^}]*!important/, 'the site-wide animation:none!important must not kill the safety net');
});

test('the reader lifts the layer after the first screen: feed page, error, picker, article — and never later than 8 s', () => {
  assert.match(app, /setTimeout\(finishLoading, 8000\)/);
  assert.match(app, /if \(isFirstPage\) \{ queueFreshCheck\(\); finishLoading\(\); \}/);
  assert.match(app, /finishLoading\(\); \/\/ the error message is on screen/);
  assert.match(app, /else openPicker\(\);\s*finishLoading\(\);/);
  assert.match(app, /ارتباط با سرور برقرار نشد[^\n]*\n\s*finishLoading\(\);/);
  assert.match(app, /\} finally \{\s*if \(initial\) finishLoading\(\);/);
  assert.match(app, /if \(loaderDone \|\| !pageLoader\) return;\s*loaderDone = true;/, 'idempotent');
  assert.ok(app.includes("pageLoader.classList.add('is-leaving')"));
});
