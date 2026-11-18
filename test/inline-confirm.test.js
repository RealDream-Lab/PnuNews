import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(`${root}package.json`, 'utf8')).version;
const script = readFileSync(`${root}public/shared/inline-edit.v${version}.js`, 'utf8');
const styles = readFileSync(`${root}public/reader/styles.v${version}.css`, 'utf8');

test('closing the inline editor with unsaved changes asks in a modal of the site, never in the browser\'s box', () => {
  assert.doesNotMatch(script, /window\.confirm|\bconfirm\(|\balert\(/);
  assert.match(script, /confirmDialog\.className = 'info-dialog confirm-dialog'/);
  assert.match(script, /confirmDialog\.showModal\(\)/);
  assert.match(script, /تغییرات ذخیره‌نشده از بین می‌رود\. بستن پنجره؟/);
});

test('only the red button discards; the safe button is focused first and Escape keeps the editor open', () => {
  assert.match(script, /data-confirm="keep" autofocus>ادامه ویرایش</);
  assert.match(script, /data-confirm="discard">بستن بدون ذخیره</);
  assert.match(script, /resolve\(confirmDialog\.returnValue === 'discard'\)/);
  assert.match(script, /confirmDialog\.returnValue = '';\s*confirmDialog\.showModal\(\)/, 'a leftover answer must not discard the next time');
});

test('the close button, Escape and the back gesture all go through the same question', () => {
  assert.match(script, /if \(dirty\(\) && !\(await askDiscard\(\)\)\) return;\s*dialog\.close\(\);/);
  assert.match(script, /dialog\.addEventListener\('keydown', \(event\) => \{\s*if \(event\.key !== 'Escape'\) return;\s*event\.preventDefault\(\);\s*requestClose\(\);/);
  assert.match(script, /dialog\.addEventListener\('cancel', \(event\) => \{\s*if \(!dirty\(\)\) return;\s*event\.preventDefault\(\);\s*requestClose\(\);/);
});

test('signing out in another tab closes the question as well as the editor', () => {
  assert.match(script, /if \(confirmDialog\?\.open\) confirmDialog\.close\(\); if \(dialog\?\.open\)/);
});

test('the modal looks like the other ones and uses theme colours', () => {
  assert.match(styles, /\.confirm-dialog\{width:min\(calc\(100% - 1\.5rem\),420px\)\}/);
  assert.match(styles, /\.button-danger\{[^}]*border:1px solid var\(--urgent\)[^}]*color:var\(--urgent\)/);
});
