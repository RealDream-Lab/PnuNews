import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const read = (relative) => readFile(fileURLToPath(new URL(relative, root)), 'utf8');
async function versioned(dir, pattern) {
  const name = (await readdir(fileURLToPath(new URL(dir, root)))).find((file) => pattern.test(file));
  assert.ok(name, `${dir} has ${pattern}`);
  return read(`${dir}${name}`);
}

test('«publish now» never sends the browser clock: a fast clock would make the news scheduled', async () => {
  const script = await versioned('public/dashboard/', /^dashboard\.v[\d.]+\.js$/);
  const body = script.slice(script.indexOf('async function publishEditor'), script.indexOf('// ---------- Quick news'));
  assert.ok(!body.includes('new Date()'), 'publishEditor does not read the browser clock');
  assert.match(body, /\.\.\.\(scheduled \? \{ published_at: state\.newsDates\.published_at \} : \{\}\)/);
  const server = await read('src/routes/news-admin.js');
  assert.match(server, /request\.body\?\.published_at === undefined \? new Date\(clock\(\)\)/, 'without a time the server uses its own clock');
});

test('the important-news strip can be moved with a mouse: arrow buttons and the wheel', async () => {
  const html = await read('public/index.html');
  const script = await versioned('public/reader/', /^app\.v[\d.]+\.js$/);
  const css = await versioned('public/reader/', /^styles\.v[\d.]+\.css$/);
  assert.match(html, /class="pinned-nav pinned-prev"/);
  assert.match(html, /class="pinned-nav pinned-next"/);
  assert.match(script, /pinnedStrip\.addEventListener\('wheel'/);
  assert.match(script, /function updatePinnedNav/);
  assert.match(script, /scrollBy\(\{ left: step \* pinnedDirection\(\)/);
  assert.match(css, /@media\(hover:hover\) and \(pointer:fine\)\{\s*\.pinned-nav:not\(\[hidden\]\)/, 'buttons are for a mouse only');
});

test('a cover whose shape differs from its frame is shown whole over a blurred copy of itself instead of being cropped', async () => {
  const script = await versioned('public/reader/', /^app\.v[\d.]+\.js$/);
  const css = await versioned('public/reader/', /^styles\.v[\d.]+\.css$/);
  assert.match(script, /const COVER_SHAPE_TOLERANCE = 0\.06;/);
  assert.match(script, /Math\.abs\(image\.naturalWidth \/ image\.naturalHeight \/ frameRatio - 1\) > COVER_SHAPE_TOLERANCE/);
  assert.match(script, /frame\.offsetWidth \/ frame\.offsetHeight : 16 \/ 9/, 'the frame\'s own shape is the reference');
  assert.match(script, /frame\.style\.setProperty\('--cover-bg'/);
  // cards, the pinned strip, the news page and its gallery all go through it
  assert.match(script, /closest\('\.card-cover-frame, \.pinned-cover-frame, \.news-page-cover-frame, \.gallery-image-frame'\)/);
  assert.match(script, /settleCover\(image\) \{[\s\S]*?fitCoverFrame\(image\);/);
  assert.match(script, /img\.news-page-cover, \.gallery-image-frame img'\)\) fitCoverFrame/);
  for (const frame of ['card-cover-frame', 'pinned-cover-frame', 'news-page-cover-frame', 'gallery-image-frame']) {
    assert.ok(css.includes(`.${frame}.is-contained::before`), `${frame} gets the blurred backdrop`);
  }
  assert.match(css, /\.is-contained>\.cover-placeholder\{display:none\}/);
  assert.match(css, /object-fit:contain\}/);
});
