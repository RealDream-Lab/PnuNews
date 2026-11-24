import assert from 'node:assert/strict';
import test from 'node:test';
import { createStaticAssets } from '../src/lib/static.js';

const assets = await createStaticAssets(new URL('../public', import.meta.url).pathname);

test('every icon the manifests name is served as image/png, not as an octet stream (Chrome checks them before offering to install)', () => {
  const icons = [...assets.keys()].filter((name) => name.startsWith('/icons/') && name.endsWith('.png'));
  assert.ok(icons.length >= 6);
  for (const name of icons) assert.equal(assets.get(name).contentType, 'image/png', name);
});

test('no file of the public folder is served as a bare octet stream', () => {
  const bare = [...assets].filter(([, asset]) => asset.contentType === 'application/octet-stream').map(([name]) => name);
  assert.deepEqual(bare, []);
});
