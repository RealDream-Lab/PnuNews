import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNewsInput, plainTextFromHtml, sanitizeBodyHtml } from '../src/news/content.js';

test('rich text sanitizer strips active content and only retains local media images', () => {
  const html = '<script>alert(1)</script><p onclick="bad()">سلام <strong>خبر</strong></p>' +
    '<a href="javascript:alert(1)" target="_blank">پیوند</a>' +
    '<img src="https://evil.invalid/image.png" onerror="bad()">' +
    '<img src="/media/img/2026/01/photo-400.webp" onerror="bad()">';
  const sanitized = sanitizeBodyHtml(html);
  assert.doesNotMatch(sanitized, /script|onclick|onerror|javascript:|evil\.invalid/i);
  assert.match(sanitized, /<strong>خبر<\/strong>/);
  assert.match(sanitized, /src="\/media\/img\/2026\/01\/photo-400\.webp"/);
  assert.match(sanitized, /rel="noopener noreferrer"/);
});

test('search content is plain Persian text and hostile numeric entities do not throw', () => {
  const content = normalizeNewsInput({
    title: 'يادداشت ۱۲',
    summary: 'متن خلاصه',
    body_html: '<h2>عنوان</h2><p>متن &amp; پیوند</p><p>&#999999999999;</p>',
  });
  assert.equal(content.title, 'یادداشت ۱۲');
  assert.match(content.search_text, /یادداشت 12/);
  assert.doesNotMatch(content.search_text, /<|>/);
  assert.match(content.search_text, /عنوان متن/);
  assert.doesNotThrow(() => plainTextFromHtml('&#x110000;'));
});
