import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(`${root}package.json`, 'utf8')).version;
const script = readFileSync(`${root}public/reader/app.v${version}.js`, 'utf8');

test('radio autoplay is off by default', () => {
  assert.match(script, /const DEFAULT_PREFS = Object\.freeze\(\{ radio: true, autoplay: false,/);
});

test('a stored "autoplay on" from the old default is switched off once per device', () => {
  assert.match(script, /const AUTOPLAY_RESET_KEY = 'pnu\.autoplay-off'/);
  assert.match(script, /localStorage\.getItem\(AUTOPLAY_RESET_KEY\) !== '1'/);
  // The reset runs after the stored values are read and before anything can start the radio.
  assert.ok(script.indexOf('AUTOPLAY_RESET_KEY) !==') > script.indexOf("typeof saved[key] === 'boolean'"));
  assert.ok(script.indexOf('AUTOPLAY_RESET_KEY) !==') < script.indexOf('function maybeAutoplayRadio'));
});

test('autoplay still only runs when the reader has switched it on', () => {
  assert.match(script, /if \(prefs\.radio && prefs\.autoplay\) dock\.autoplayRadio\(\)/);
});
