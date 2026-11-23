import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(`${root}package.json`, 'utf8')).version;
const script = readFileSync(`${root}public/reader/app.v${version}.js`, 'utf8');
const styles = readFileSync(`${root}public/reader/styles.v${version}.css`, 'utf8');

test('the feed packs its cards (masonry) at every width where they sit in two or three columns, tablets included', () => {
  assert.match(script, /const masonryQuery = matchMedia\('\(min-width: 640px\)'\);/, 'masonry starts where the second column starts');
  const twoColumns = styles.slice(styles.indexOf('@media(min-width:640px){'), styles.indexOf('@media(min-width:960px){'));
  assert.match(twoColumns, /\.news-feed\.is-masonry\{grid-auto-rows:8px;grid-auto-flow:row dense;row-gap:0;/, 'the 8px row grid applies from 640px, not only from 960px');
  assert.match(twoColumns, /\.news-feed\.is-masonry>\*\{align-self:start\}/);
  assert.equal((styles.match(/\.news-feed\.is-masonry\{/g) ?? []).length, 1, 'declared once, so the two media queries cannot disagree');
});

test('the number of skeleton cards still follows the real column count', () => {
  assert.match(script, /const perRow = matchMedia\('\(min-width: 960px\)'\)\.matches \? 3 : masonryQuery\.matches \? 2 : 1;/);
});
