import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(`${root}package.json`, 'utf8')).version;
const script = readFileSync(`${root}public/reader/app.v${version}.js`, 'utf8');

test('the reader\'s saved center is never erased because the list was empty or missing it for a moment', () => {
  assert.ok(!script.includes("removeItem('pnu.city')"), 'only choosing another center overwrites it');
  assert.match(script, /const listReady = Array\.isArray\(nextConfig\.provinces\) && nextConfig\.provinces\.length > 0;\s*if \(state\.city && !selected && listReady\)/);
  assert.match(script, /if \(savedCityId && !config\.provinces\?\.length\) feedMessage\.textContent = /, 'an empty list is a "not ready" message, not the picker');
  assert.match(script, /localStorage\.setItem\('pnu\.city', String\(city\.id\)\)/);
});
