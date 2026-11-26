import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createPublicRouter } from '../src/routes/public.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(`${root}package.json`, 'utf8')).version;
const read = (relative) => readFileSync(`${root}${relative}`, 'utf8');

// News: 1 is an ordinary one, 2 is a portal-feed one (opens on pnu.ac.ir), 3 is not visible.
function fakePool(clock) {
  const news = new Map([
    [1, { view_count: 10, source_url: null, visible: true }],
    [2, { view_count: 40, source_url: 'https://pnu.ac.ir/x', visible: true }],
    [3, { view_count: 5, source_url: 'https://pnu.ac.ir/y', visible: false }],
  ]);
  const updates = [];
  const answer = async (sql, params = []) => {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT n\.view_count, n\.source_url FROM news n WHERE n\.id = \?/.test(text)) {
      const row = news.get(params[0]);
      return [row?.visible ? [{ view_count: row.view_count, source_url: row.source_url }] : [], []];
    }
    if (/^UPDATE news SET view_count = view_count \+ 1/.test(text)) { news.get(params[0]).view_count += 1; updates.push(params[0]); return [{ affectedRows: 1 }, []]; }
    if (/FROM settings/.test(text)) return [[], []];
    return [[], []];
  };
  return { pool: { query: answer, execute: answer }, news, updates };
}

async function viewApp(clock, run) {
  const database = fakePool(clock);
  const app = express();
  app.use(express.json());
  app.use(createPublicRouter({ pool: database.pool, config: { publicUrl: 'https://news.example.ir' }, events: new EventEmitter(), staticAssets: null, clock: () => clock.now }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const post = (id) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: `/api/public/news/${id}/view`, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null, headers: res.headers }));
    });
    req.on('error', reject);
    req.end('{}');
  });
  try { return await run({ post, ...database }); } finally { server.close(); server.closeAllConnections?.(); }
}

test('a tap on a portal-feed card is a view: counted once per half hour per visitor, and the answer is the new total', async () => {
  const clock = { now: Date.UTC(2026, 10, 26, 8) };
  await viewApp(clock, async ({ post, news, updates }) => {
    const first = await post(2);
    assert.equal(first.status, 200);
    assert.deepEqual(first.json, { ok: true, view_count: 41 });
    assert.equal(first.headers['cache-control'], 'no-store');
    assert.deepEqual((await post(2)).json, { ok: true, view_count: 41 }, 'the same visitor again: not another view');
    assert.equal(updates.length, 1);
    clock.now += 31 * 60_000;
    assert.deepEqual((await post(2)).json, { ok: true, view_count: 42 }, 'half an hour later it counts again');
    assert.equal(news.get(2).view_count, 42);
  });
});

test('only portal news is counted this way; the page of any other news counts its own views, so nothing is added twice', async () => {
  await viewApp({ now: Date.UTC(2026, 10, 26, 8) }, async ({ post, updates }) => {
    assert.deepEqual((await post(1)).json, { ok: true, view_count: 10 });
    assert.equal(updates.length, 0);
  });
});

test('unknown, hidden or malformed news answers «not found» and counts nothing', async () => {
  await viewApp({ now: Date.UTC(2026, 10, 26, 8) }, async ({ post, updates }) => {
    for (const id of [3, 99, 0, 'abc', '-4']) assert.equal((await post(id)).status, 404, String(id));
    assert.equal(updates.length, 0);
  });
});

test('the card shows the number as an eye and a short count, one national total, hidden while it is zero', () => {
  const app = read(`public/reader/app.v${version}.js`);
  const css = read(`public/reader/styles.v${version}.css`);
  const html = read('public/index.html');
  assert.match(html, /<symbol id="icon-eye" viewBox="0 0 24 24">/);
  assert.match(app, /if \(count < 10_000\) return digits\.format\(count\);/);
  assert.match(app, /هزار`;/);
  assert.match(app, /میلیون`;/);
  assert.match(app, /if \(!Number\.isFinite\(count\) \|\| count <= 0\) return '';/, 'nothing is drawn for a news nobody opened');
  assert.match(app, /aria-label="\$\{digits\.format\(count\)\} بازدید"/);
  // every kind of card has it: the footer of a card without a cover (ordinary and portal), and a pill on the image of a card with a cover
  assert.equal((app.match(/\$\{cardViewsMarkup\(item\)\}\$\{cardSaveMarkup\(item\)\}/g) ?? []).length, 2);
  assert.match(app, /<div class="card-cover-frame">\$\{placeholder\}\$\{cardViewsMarkup\(item\)\}/);
  assert.ok(!app.includes('cardViewsInline'), 'not in the translucent strip any more');
  assert.match(css, /\.card-cover-frame \.card-views\{position:absolute;inset-block-start:\.5rem;inset-inline-start:\.5rem;z-index:4;[^}]*pointer-events:none\}/);
  assert.match(css, /\.card-views\{flex:none;display:inline-flex;/);
});

test('opening a portal news (from a card or from the saved list) reports the tap and updates the number on every card of that news', () => {
  const app = read(`public/reader/app.v${version}.js`);
  assert.match(app, /fetch\(`\/api\/public\/news\/\$\{Number\(id\)\}\/view`, \{ method: 'POST', headers: \{ 'content-type': 'application\/json' \}, body: '\{\}', keepalive: true \}\)/);
  assert.equal((app.match(/noteExternalView\(/g) ?? []).length, 4, 'defined once and called from the card and twice from the saved list');
  assert.match(app, /noteExternalView\(card\.dataset\.newsId\);\s*window\.open\(address/);
  assert.match(app, /\.catch\(\(\) => \{\}\); \/\/ offline or blocked/);
});

test('tapping a card or an icon on a phone does not flash blue or leave a focus ring; the keyboard keeps its ring', () => {
  const css = read(`public/reader/styles.v${version}.css`);
  assert.match(css, /\.news-card,\.pinned-card,\.news-card \*,\.pinned-card \*,a,button,\[role=link\],\[role=button\],\[tabindex\]\{-webkit-tap-highlight-color:transparent\}/);
  assert.match(css, /\.news-card:focus:not\(:focus-visible\),\.pinned-card:focus:not\(:focus-visible\),button:focus:not\(:focus-visible\)\{outline:none\}/);
  assert.match(css, /\.card-save:focus-visible\{outline:2px solid currentColor/, 'the keyboard ring of the icons is untouched');
});
