import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(`${root}package.json`, 'utf8')).version;
const app = readFileSync(`${root}public/reader/app.v${version}.js`, 'utf8');

test('the translucent strip over a cover has the centre label on the first line and only the date on the second', () => {
  assert.match(app, /const overlay = `<div class="card-meta-overlay">\$\{labels\}<div class="overlay-row">\$\{time\}<\/div>\$\{cardSaveMarkup\(item\)\}/);
  assert.ok(!/overlay-row">\$\{source\}/.test(app), 'the unit name is no longer on the second line of the strip');
  // Without a cover the unit name stays in the footer line.
  assert.match(app, /<div class="card-foot">\$\{source\}\$\{time\}/);
});

test('an older date reads «date ساعت time», not «date — time»', () => {
  const body = app.slice(app.indexOf('function relativeDate'), app.indexOf('function safeColorCode'));
  assert.match(body, /return `\$\{dateFormatter\.format\(date\)\} ساعت \$\{timeFormatter\.format\(date\)\}`;/);
  assert.ok(!body.includes(' — '));
});
