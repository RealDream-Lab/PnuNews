import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { brandNameOutput } from '../src/lib/brand-output.js';
import { normalizeBrandDeep, normalizeBrandName } from '../src/lib/fa.js';
import { sanitizeBodyHtml } from '../src/news/content.js';

const BRAND = 'پیام\u200cنور';

test('the university name gets a half-space in every written variant', () => {
  for (const variant of ['پیام نور', 'پیام   نور', 'پیام\u00a0نور', 'پیامنور', BRAND, 'پيام نور']) {
    assert.equal(normalizeBrandName(variant), BRAND, variant);
  }
  assert.equal(normalizeBrandName('اخبار پیام نور، استان البرز'), `اخبار ${BRAND}، استان البرز`);
  assert.equal(normalizeBrandName(normalizeBrandName('پیام نور')), BRAND, 'idempotent');
  assert.equal(normalizeBrandName(null), '');
});

test('similar words are left alone', () => {
  for (const text of ['پیام نوروز مبارک', 'پیام نورانی', 'آپیام نور', 'پیام و نور']) {
    assert.equal(normalizeBrandName(text), text, text);
  }
});

test('deep normalization copies JSON values and skips HTML fields', () => {
  const date = new Date('2026-01-01T00:00:00Z');
  const source = { title: 'خبر پیام نور', n: 3, ok: true, none: null, date, list: ['دانشگاه پیام نور'], nested: { unit: 'پیام نور بیجار' }, body_html: '<p>پیام نور</p>' };
  const result = normalizeBrandDeep(source);
  assert.equal(result.title, `خبر ${BRAND}`);
  assert.equal(result.list[0], `دانشگاه ${BRAND}`);
  assert.equal(result.nested.unit, `${BRAND} بیجار`);
  assert.equal(result.body_html, '<p>پیام نور</p>');
  assert.equal(result.date, date);
  assert.equal(result.n, 3);
  assert.equal(source.title, 'خبر پیام نور', 'the input is not mutated');
});

test('sanitized body HTML is normalized for output only, in text nodes only', () => {
  const html = '<p>دانشگاه پیام نور</p><a href="https://example.com/پیام نور">پیام نور</a>';
  assert.match(sanitizeBodyHtml(html), /<p>دانشگاه پیام نور<\/p>/, 'saving keeps the text as written');
  const output = sanitizeBodyHtml(html, { brand: true });
  assert.match(output, new RegExp(`<p>دانشگاه ${BRAND}</p>`));
  assert.match(output, new RegExp(`>${BRAND}</a>`));
  assert.ok(output.includes('/پیام%20نور') || output.includes('/پیام نور'), 'URLs are not changed');
});

test('the JSON middleware changes the response only', async () => {
  const stored = { title: 'اخبار پیام نور', items: [{ unit: 'دانشگاه پیام نور استان البرز' }] };
  const app = express();
  app.use('/api', brandNameOutput);
  app.get('/api/x', (request, response) => response.json(stored));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const body = await (await fetch(`http://127.0.0.1:${server.address().port}/api/x`)).json();
    assert.equal(body.title, `اخبار ${BRAND}`);
    assert.equal(body.items[0].unit, `دانشگاه ${BRAND} استان البرز`);
    assert.equal(stored.title, 'اخبار پیام نور');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
