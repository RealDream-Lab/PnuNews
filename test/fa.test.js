import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchText, normalizeFa } from '../src/lib/fa.js';

test('normalizes Arabic letters, Persian and Arabic digits, tatweel, and spacing', () => {
  assert.equal(normalizeFa('ي ك ۱۲۳ ٤٥٦ ـ تهران‌مرکز مدرسـه'), 'ی ک 123 456 تهران مرکز مدرسه');
});

test('builds a normalized search string from available values', () => {
  assert.equal(buildSearchText('آموزشی', null, 'امتحانات ١'), 'آموزشی امتحانات 1');
});
