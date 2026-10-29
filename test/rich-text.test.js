import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeBodyHtml } from '../src/news/content.js';

// What the editor toolbar produces must reach the reader intact; everything else is still stripped.

test('bold, italic and underline from the browser editor are stored as strong, em and u', () => {
  assert.equal(sanitizeBodyHtml('<b>الف</b><i>ب</i><u>ج</u>'), '<strong>الف</strong><em>ب</em><u>ج</u>');
});

test('alignment survives as a class on the blocks', () => {
  for (const name of ['right', 'left', 'center', 'justify']) {
    assert.equal(sanitizeBodyHtml(`<p class="ta-${name}">متن</p>`), `<p class="ta-${name}">متن</p>`);
  }
  assert.equal(sanitizeBodyHtml('<ul><li class="ta-center">الف</li></ul>'), '<ul><li class="ta-center">الف</li></ul>');
});

test('text-align in a style attribute becomes a class and the style is dropped (the CSP forbids inline styles)', () => {
  assert.equal(sanitizeBodyHtml('<p style="text-align: right;">الف</p>'), '<p class="ta-right">الف</p>');
  assert.equal(sanitizeBodyHtml('<div style="text-align:justify">الف</div>'), '<p class="ta-justify">الف</p>');
  assert.equal(sanitizeBodyHtml('<p class="ta-center" style="text-align:left">الف</p>'), '<p class="ta-left">الف</p>');
  assert.equal(sanitizeBodyHtml('<p style="color:red;background:url(x)">الف</p>'), '<p>الف</p>');
});

test('Persian numbering is kept on ol only', () => {
  assert.equal(sanitizeBodyHtml('<ol class="fa-num"><li>الف</li></ol>'), '<ol class="fa-num"><li>الف</li></ol>');
  assert.equal(sanitizeBodyHtml('<ul class="fa-num"><li>الف</li></ul>'), '<ul><li>الف</li></ul>');
});

test('other classes, handlers and unsafe links are still removed', () => {
  assert.equal(sanitizeBodyHtml('<p class="evil ta-center" onclick="x()">الف</p>'), '<p class="ta-center">الف</p>');
  assert.ok(!sanitizeBodyHtml('<a href="javascript:alert(1)">x</a>').includes('javascript'));
});
