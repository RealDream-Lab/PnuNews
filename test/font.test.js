import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(`${root}package.json`, 'utf8')).version;
const html = readFileSync(`${root}public/index.html`, 'utf8');
const script = readFileSync(`${root}public/reader/app.v${version}.js`, 'utf8');
const styles = readFileSync(`${root}public/reader/styles.v${version}.css`, 'utf8');
const theme = readFileSync(`${root}public/shared/theme.v${version}.js`, 'utf8');
const worker = readFileSync(`${root}public/sw.js`, 'utf8');

test('Dastkhat is served from the project itself, so no external font service is needed', () => {
  assert.ok(existsSync(`${root}public/fonts/Dastkhat-Variable.v1.woff2`));
  assert.ok(existsSync(`${root}docs/licenses/Dastkhat-OFL.txt`), 'the OFL licence travels with the font');
  assert.match(styles, /@font-face\{font-family:Dastkhat;src:url\('\/fonts\/Dastkhat-Variable\.v1\.woff2'\) format\('woff2'\);font-weight:100 900;/);
  assert.doesNotMatch(styles, /https?:\/\/[^)'"]*woff2/, 'no font may come from another host');
});

test('Dastkhat is the main font and Vazirmatn the second one', () => {
  assert.match(styles, /:root\[data-font="dastkhat"\]\{font-family:Dastkhat,Vazirmatn,/);
  assert.match(styles, /@font-face\{font-family:Vazirmatn;/, 'Vazirmatn stays available as the second font and as the default when the option is off');
});

test('the settings dialog has a switch for the font and it is on by default', () => {
  assert.match(html, /<strong>فونت دستخط<\/strong>[^]*?data-pref="dastkhat"/);
  assert.match(script, /DEFAULT_PREFS = Object\.freeze\(\{ dastkhat: true,/);
  assert.match(script, /dataset\.font = prefs\.dastkhat \? 'dastkhat' : 'vazirmatn'/);
});

test('changing the font switch does not reload the news feed', () => {
  const handler = script.slice(script.indexOf("settingsDialog.addEventListener('change'"));
  assert.match(handler, /if \(key === 'dastkhat'\) \{\s*applyFontPreference\(\);\s*scheduleMasonry\(\);\s*\} else if \(key === 'radio'\)/);
});

test('the stored choice is applied before the first paint, with Dastkhat as the default', () => {
  assert.match(theme, /localStorage\.getItem\('pnu\.prefs'\)/);
  assert.match(theme, /typeof saved\?\.dastkhat === 'boolean' \? saved\.dastkhat : true/);
  assert.match(theme, /root\.dataset\.font = dastkhatOn\(\) \? 'dastkhat' : 'vazirmatn'/);
});

test('the service worker caches the font with the app shell', () => {
  assert.ok(worker.includes("'/fonts/Dastkhat-Variable.v1.woff2'"));
});
