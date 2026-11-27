import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { FLAG_LIFETIME_MS, flagsHaveExpired } from '../src/news/flag-expiry.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(`${root}package.json`, 'utf8')).version;
const read = (relative) => readFileSync(`${root}${relative}`, 'utf8');

test('the rule: 72 hours after publishing the flags are over; a draft or a scheduled news has not expired', () => {
  const published = Date.UTC(2026, 10, 20, 8);
  assert.equal(flagsHaveExpired(new Date(published), published + FLAG_LIFETIME_MS - 1), false);
  assert.equal(flagsHaveExpired(new Date(published), published + FLAG_LIFETIME_MS), true);
  assert.equal(flagsHaveExpired(null), false);
  assert.equal(flagsHaveExpired(new Date(published + 1e9), published), false);
});

test('the server tells the editor when the flags are over, in the same answer that carries the news', () => {
  const route = read('src/routes/news-admin.js');
  assert.match(route, /news\.flags_expired = news\.status === 'published' && flagsHaveExpired\(news\.published_at, clock\(\)\);\s*return response\.json\(\{ item: news \}\);/);
});

test('in the in-place editor the «important» and «urgent» choices are not shown once they are over, and are never sent', () => {
  const editor = read(`public/shared/inline-edit.v${version}.js`);
  assert.match(editor, /dialog\.querySelector\('\.edit-flags'\)\.hidden = Boolean\(item\.flags_expired\);/);
  assert.match(editor, /for \(const \[flag, field\] of item\.flags_expired \? \[\] : \[\['pin', 'is_pinned'\], \['urgent', 'is_urgent'\]\]\)/);
  assert.match(read(`public/reader/styles.v${version}.css`), /\.edit-flags\[hidden\]\{display:none\}/, 'the hidden attribute wins over the flex layout');
});
