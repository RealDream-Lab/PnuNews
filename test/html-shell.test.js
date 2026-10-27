import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const voidElements = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function assertWellFormedElements(markup, file) {
  const stack = [];
  for (const match of markup.matchAll(/<\/?([a-z][\w:-]*)\b[^>]*>/gi)) {
    const [tag, name] = match;
    const normalized = name.toLowerCase();
    if (tag.startsWith('</')) {
      assert.equal(stack.pop(), normalized, `${file}: unexpected closing </${normalized}>`);
    } else if (!voidElements.has(normalized) && !/\/\s*>$/.test(tag)) {
      stack.push(normalized);
    }
  }
  assert.deepEqual(stack, [], `${file}: unclosed elements`);
}

async function readPublicFile(name) {
  return readFile(new URL(`../public/${name}`, import.meta.url), 'utf8');
}

test('reader, admin, and offline pages have balanced markup and local scripts', async () => {
  for (const name of ['admin/index.html', 'offline.html', 'index.html']) {
    const markup = await readPublicFile(name);
    assert.match(markup, /^<!doctype html>/i, `${name}: doctype`);
    assert.match(markup, /<head>[\s\S]*<\/head>/i, `${name}: head`);
    assert.match(markup, /<body>[\s\S]*<\/body>/i, `${name}: body`);
    assertWellFormedElements(markup, name);
    assert.doesNotMatch(markup, /<script(?![^>]*\bsrc=)[^>]*>/i, `${name}: inline scripts are forbidden`);
  }
});

test('admin document provides every JavaScript element hook exactly once', async () => {
  const markup = await readPublicFile('admin/index.html');
  const script = await readFile(new URL('../public/admin/admin.v7.js', import.meta.url), 'utf8');
  const ids = [...markup.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'admin document IDs must be unique');
  const idSet = new Set(ids);
  const referencedIds = [...script.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map((match) => match[1]);
  for (const id of new Set(referencedIds)) assert.ok(idSet.has(id), `admin document is missing #${id}`);
  assert.match(markup, /<title>[^<]+<\/title>/i);
});

test('offline page contains an actionable, non-empty offline message', async () => {
  const markup = await readPublicFile('offline.html');
  assert.match(markup, /<title>عدم دسترسی — اخبار پیام نور<\/title>/);
  assert.match(markup, /<h1>در حال حاضر آفلاین هستید<\/h1>/);
  assert.match(markup, /<a class="news-back" href="\/">تلاش دوباره<\/a>/);
});

test('reader shell has no scope chips, one sticky dock with the radio mount, and a two-state theme script', async () => {
  const markup = await readPublicFile('index.html');
  assert.doesNotMatch(markup, /scope-chip|scope-row/);
  assert.match(markup, /<footer class="site-dock">[\s\S]*<span class="dock-text">[\s\S]*<div id="radio-root"><\/div>[\s\S]*<\/footer>/);
  const theme = await readPublicFile('shared/theme.v7.js');
  assert.doesNotMatch(theme, /'auto'/);
});

test('web app manifest declares installable PNG icons and every referenced file exists', async () => {
  const manifest = JSON.parse(await readPublicFile('manifest.webmanifest'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  for (const purpose of ['any', 'maskable']) {
    for (const size of ['192x192', '512x512']) {
      assert.ok(manifest.icons.some((icon) => icon.purpose === purpose && icon.sizes === size && icon.type === 'image/png'), `${purpose} ${size} icon`);
    }
  }
  for (const icon of manifest.icons) assert.ok((await readFile(new URL(`../public${icon.src}`, import.meta.url))).length > 0, icon.src);
});

test('service worker precache list only names files that exist in public/', async () => {
  const worker = await readPublicFile('sw.js');
  const list = worker.match(/SHELL_ASSETS = \[([\s\S]*?)\];/)[1];
  const assets = [...list.matchAll(/'([^']+)'/g)].map((match) => match[1]).filter((asset) => asset !== '/');
  assert.ok(assets.length > 5);
  for (const asset of assets) await readPublicFile(asset.slice(1));
});

test('reader and offline pages link the manifest and icons', async () => {
  for (const name of ['index.html', 'offline.html']) {
    const markup = await readPublicFile(name);
    assert.match(markup, /rel="manifest"/, name);
    assert.match(markup, /rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.v1\.png"/, name);
  }
});
