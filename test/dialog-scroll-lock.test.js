import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(`${root}package.json`, 'utf8')).version;
const styles = readFileSync(`${root}public/reader/styles.v${version}.css`, 'utf8');
const html = readFileSync(`${root}public/index.html`, 'utf8');
const script = readFileSync(`${root}public/reader/app.v${version}.js`, 'utf8');

test('the page behind an open dialog cannot scroll', () => {
  assert.match(styles, /html:has\(dialog\[open\]\)\{overflow:hidden;scrollbar-gutter:stable\}/);
});

test('a dialog panel does not hand its scroll on to the page when it reaches its end', () => {
  assert.match(styles, /\.info-panel\{[^}]*overflow:auto;overscroll-behavior:contain;/);
});

test('every reader dialog is opened as a modal, so the lock above covers all of them', () => {
  assert.ok(!/\.show\(\)/.test(script), 'a non-modal dialog would lock the page without a backdrop');
  assert.ok((html.match(/<dialog /g) || []).length >= 6);
});

test('the saved-news list is the dialog that is locked', () => {
  assert.match(html, /<dialog id="saved-dialog" class="info-dialog saved-dialog"/);
  assert.match(script, /savedDialog\.showModal\(\)/);
});
