import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(`${root}package.json`, 'utf8')).version;
const styles = readFileSync(`${root}public/reader/styles.v${version}.css`, 'utf8');

test('the small important/urgent cards use a smaller title that shows up to three lines', () => {
  assert.match(styles, /\.pinned-card h2\{font-size:\.82rem;line-height:1\.5;margin:0;display:-webkit-box;-webkit-line-clamp:3;line-clamp:3;/);
  assert.match(styles, /\.pinned-card \.card-kicker\{font-size:\.7rem;line-height:1\.5\}/);
});

test('the title scales with the reader\'s A+/A− buttons (rem, not px) and the ordinary cards are untouched', () => {
  const rule = styles.split('\n').find((line) => line.startsWith('.pinned-card h2{'));
  assert.doesNotMatch(rule, /px/);
  assert.doesNotMatch(styles, /\.news-card h2\{[^}]*\.82rem/);
});

test('the urgent card in the strip has the same frame as the others (only its label is red)', () => {
  const version = JSON.parse(readFileSync(`${root}package.json`, 'utf8')).version;
  const styles = readFileSync(`${root}public/reader/styles.v${version}.css`, 'utf8');
  assert.ok(!/\.pinned-card\.is-urgent\{[^}]*border/.test(styles), 'no red frame');
  assert.match(styles, /\.pinned-card\.is-urgent \.card-kicker\{color:var\(--urgent\)/);
  assert.match(styles, /\.pinned-card\{[^}]*border:1px solid var\(--border\)/);
});
