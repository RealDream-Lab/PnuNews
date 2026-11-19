import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (file) => readFileSync(path.join(root, file), 'utf8');
const version = JSON.parse(read('package.json')).version;
const { formatBuildDate, loadBuildDate } = await import(`../public/shared/build-date.v${version}.js`);

test('the build date is Jalali, in Tehran time, written like "۲۰ مهر ماه ۱۴۰۵ ساعت ۱۶:۲۷"', () => {
  assert.equal(formatBuildDate('2026-10-12T12:57:00Z'), '۲۰ مهر ماه ۱۴۰۵ ساعت ۱۶:۲۷');
  assert.equal(formatBuildDate('2026-03-21T10:00:00Z'), '۱ فروردین ماه ۱۴۰۵ ساعت ۱۳:۳۰');
  assert.equal(formatBuildDate('2027-03-19T22:00:00Z'), '۲۹ اسفند ماه ۱۴۰۵ ساعت ۰۱:۳۰', 'last day of 1405 (Tehran is already past midnight)');
});

test('the day changes at 00:00 Tehran time, not at 00:00 UTC', () => {
  assert.equal(formatBuildDate('2026-10-12T20:29:59Z'), '۲۰ مهر ماه ۱۴۰۵ ساعت ۲۳:۵۹');
  assert.equal(formatBuildDate('2026-10-12T20:30:00Z'), '۲۱ مهر ماه ۱۴۰۵ ساعت ۰۰:۰۰');
  assert.equal(formatBuildDate('2026-10-12T00:10:00Z'), '۲۰ مهر ماه ۱۴۰۵ ساعت ۰۳:۴۰', 'a UTC time that is still the same Tehran day');
});

test('a missing or broken stamp gives no text instead of an error or "Invalid Date"', async () => {
  for (const bad of ['nope', '', null, undefined, 12345, {}]) assert.equal(formatBuildDate(bad), '');
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false });
    assert.equal(await loadBuildDate(), '', '404');
    globalThis.fetch = async () => { throw new TypeError('offline'); };
    assert.equal(await loadBuildDate(), '', 'offline');
    globalThis.fetch = async () => ({ ok: true, json: async () => { throw new SyntaxError('bad json'); } });
    assert.equal(await loadBuildDate(), '', 'damaged file');
    globalThis.fetch = async (url, options) => {
      assert.equal(url, '/build-info.json');
      assert.equal(options.cache, 'no-cache', 'always checked with the server, so a new build never shows the old date');
      return { ok: true, json: async () => ({ builtAt: '2026-10-12T12:57:00Z', version: '0.1.125' }) };
    };
    assert.equal(await loadBuildDate(), '۲۰ مهر ماه ۱۴۰۵ ساعت ۱۶:۲۷');
  } finally {
    globalThis.fetch = original;
  }
});

test('the stamp script writes { builtAt (UTC, to the second), version } and refuses nonsense', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'stamp-'));
  try {
    const file = path.join(dir, 'build-info.json');
    execFileSync('node', ['scripts/stamp-build.js', file, '--at', '2026-10-12T12:57:00.789Z'], { cwd: root, stdio: 'pipe' });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { builtAt: '2026-10-12T12:57:00Z', version });
    const before = Date.now();
    execFileSync('node', ['scripts/stamp-build.js', file], { cwd: root, stdio: 'pipe' });
    const stamped = JSON.parse(readFileSync(file, 'utf8'));
    assert.match(stamped.builtAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.ok(Math.abs(Date.parse(stamped.builtAt) - before) < 5000, 'without --at it is "now"');
    assert.throws(() => execFileSync('node', ['scripts/stamp-build.js', file, '--at', 'garbage'], { cwd: root, stdio: 'pipe' }));
    assert.throws(() => execFileSync('node', ['scripts/stamp-build.js'], { cwd: root, stdio: 'pipe' }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the deploy script stamps the build in the worktree and force-adds it with node_modules (before the tree is written)', () => {
  const script = read('scripts/make-deploy-branch.sh');
  const stamp = script.indexOf('node "$worktree/scripts/stamp-build.js" "$worktree/public/build-info.json"');
  const add = script.indexOf('add -f node_modules public/build-info.json');
  const tree = script.indexOf('write-tree');
  assert.ok(stamp > 0 && add > stamp && tree > add);
});

test('About has a hidden build line with its icon; the dialog loads the formatter only when opened', () => {
  const html = read('public/index.html');
  assert.match(html, /<p class="info-meta" id="about-build-row" hidden>[^]*?#icon-calendar[^]*?<b id="about-build"><\/b>/);
  assert.ok(html.includes('<symbol id="icon-calendar"'));
  assert.ok(html.indexOf('id="about-version"') < html.indexOf('id="about-build-row"'), 'right below the version');
  assert.match(read(`public/reader/styles.v${version}.css`), /\.info-meta\[hidden\]\{display:none\}/);
  const app = read(`public/reader/app.v${version}.js`);
  assert.ok(app.includes(`import('/shared/build-date.v${version}.js')`));
  assert.ok(!/^import .*build-date/m.test(app));
  assert.match(app, /aboutDialog\.showModal\(\);\s*showBuildDate\(\);/);
});
