import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../public/${path}`, import.meta.url), 'utf8');

test('the phone manifests lock the installed reader to portrait; the desktop and tablet manifests do not', async () => {
  for (const name of ['manifest-phone', 'manifest-phone-dark']) {
    const manifest = JSON.parse(await read(`${name}.webmanifest`));
    assert.equal(manifest.orientation, 'portrait', name);
    assert.equal(manifest.scope, '/', name);
  }
  for (const name of ['manifest', 'manifest-dark', 'manifest-mobile', 'manifest-mobile-dark']) {
    assert.equal(JSON.parse(await read(`${name}.webmanifest`)).orientation, 'any', `${name} (tablets and desktops rotate freely)`);
  }
});

test('the phone manifests differ from the mobile ones only in orientation', async () => {
  for (const dark of ['', '-dark']) {
    const phone = JSON.parse(await read(`manifest-phone${dark}.webmanifest`));
    const mobile = JSON.parse(await read(`manifest-mobile${dark}.webmanifest`));
    assert.deepEqual({ ...phone, orientation: 'any' }, mobile);
  }
});

test('the reader links one fixed manifest and the theme script never rewrites it; only the panel switches manifests', async () => {
  const { readdir } = await import('node:fs/promises');
  const file = (await readdir(new URL('../public/shared/', import.meta.url))).find((name) => /^theme\.v[\d.]+\.js$/.test(name));
  const code = await read(`shared/${file}`);
  const page = await read('index.html');
  assert.match(page, /<link rel="manifest" href="\/manifest-dark\.webmanifest" id="app-manifest">/);
  assert.ok(!page.includes('data-manifest-base'), 'the reader page has no manifest base to switch');
  assert.match(code, /if \(link\?\.dataset\.manifestBase\) \{/);
  assert.ok(!code.includes("'-phone'"), 'no phone manifest name is built (the panel has none, it would be a 404)');
  const panel = await read('dashboard/index.html');
  assert.match(panel, /data-manifest-base="\/dashboard\/manifest"/);
  // the portrait lock for the installed phone app is still asked of the browser
  assert.match(code, /Math\.min\(screen\.width, screen\.height\) < 600/);
  assert.match(code, /screen\.orientation\?\.lock/);
});
