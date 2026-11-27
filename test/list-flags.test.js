import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { FLAG_LIFETIME_MS, flagsExpiredFor } from '../src/news/flag-expiry.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(`${root}package.json`, 'utf8')).version;
const read = (relative) => readFileSync(`${root}${relative}`, 'utf8');
const script = read(`public/dashboard/dashboard.v${version}.js`);

test('the lists get «flags_expired» from the server clock: only published news inside the 72 hours is open', () => {
  const published = Date.UTC(2026, 10, 24, 6);
  assert.equal(flagsExpiredFor({ status: 'published', published_at: new Date(published) }, published + FLAG_LIFETIME_MS - 1), false);
  assert.equal(flagsExpiredFor({ status: 'published', published_at: new Date(published) }, published + FLAG_LIFETIME_MS), true);
  assert.equal(flagsExpiredFor({ status: 'draft', published_at: null }), false);
  assert.equal(flagsExpiredFor(null), false);
  assert.match(read('src/routes/news-admin.js'), /for \(const item of items\) item\.flags_expired = flagsExpiredFor\(item, listedAt\);/);
  const stats = read('src/routes/admin.js');
  assert.match(stats, /n\.source_url, n\.is_pinned, n\.is_urgent\s+FROM news n JOIN users creator/, 'the latest-news list needs the current state of both flags');
  assert.match(stats, /latest\[0\]\.map\(\(item\) => \(\{ \.\.\.item, flags_expired: flagsExpiredFor\(item, clock\(\)\) \}\)\)/);
});

// The button builder runs here as it runs in the browser (it only needs escapeless numbers and strings).
function buttonsFor(item) {
  const start = script.indexOf('const FLAG_BUTTONS');
  const end = script.indexOf('async function toggleFlag');
  const sandbox = {};
  vm.runInNewContext(`${script.slice(start, end)}; result = flagButtons;`.replace('result =', 'this.flagButtons ='), sandbox);
  return sandbox.flagButtons(item);
}

test('«مهم» and «فوری» buttons appear on published news inside the window, and show the current state', () => {
  const open = buttonsFor({ id: 7, status: 'published', flags_expired: false, is_pinned: 1, is_urgent: 0 });
  assert.match(open, /data-flag="pin" data-id="7" aria-pressed="true"[^>]*>مهم</);
  assert.match(open, /data-flag="urgent" data-id="7" aria-pressed="false"[^>]*>فوری</);
  assert.equal((open.match(/data-action="toggle-flag"/g) ?? []).length, 2);
});

test('no buttons for old news, drafts or scheduled news', () => {
  assert.equal(buttonsFor({ id: 7, status: 'published', flags_expired: true, is_pinned: 0, is_urgent: 0 }), '');
  assert.equal(buttonsFor({ id: 8, status: 'draft', flags_expired: false }), '');
  assert.equal(buttonsFor({ id: 9, status: 'scheduled', flags_expired: false }), '');
});

test('the buttons sit next to «مشاهده» in the dashboard list, the news table and the feed, and a click needs no editor', () => {
  assert.match(script, /<div class="compact-actions">\$\{flagButtons\(item\)\}<button class="mini-button" type="button" data-action="\$\{action\}"/, 'dashboard list, my news and the feed');
  assert.match(script, /<td><div class="compact-actions">\$\{flagButtons\(item\)\}<button class="mini-button" type="button" data-action="edit-news"/, 'the news table');
  assert.match(script, /const flagButton = event\.target\.closest\('\[data-action="toggle-flag"\]'\);\s*if \(flagButton\) return toggleFlag\(flagButton\);/);
  const toggle = script.slice(script.indexOf('async function toggleFlag'), script.indexOf('function compactNews'));
  assert.match(toggle, /api\(`\/api\/admin\/news\/\$\{id\}\/\$\{flag\}`, \{\s*method: "POST",\s*body: \{ enabled: enable \},/);
  assert.match(toggle, /setAttribute\("aria-pressed", String\(enable\)\)/, 'updated in place, the row does not jump');
  assert.match(toggle, /label\.hidden = !enable/, 'the «فوری» label of the table follows');
  assert.match(toggle, /catch \(error\) \{\s*showToast\(error\.message\);/, 'the server\'s refusal (e.g. window closed) is shown');
});

test('the toggle style, in both themes', () => {
  const css = read(`public/dashboard/styles.v${version}.css`);
  assert.match(css, /\.flag-toggle\[aria-pressed="true"\]\{background:var\(--primary\);border-color:var\(--primary\);color:var\(--surface\)\}/);
  assert.match(css, /\.flag-toggle\[data-flag="urgent"\]\[aria-pressed="true"\]\{background:var\(--danger\);border-color:var\(--danger\)\}/);
});
