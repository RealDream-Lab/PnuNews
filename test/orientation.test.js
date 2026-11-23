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

test('the theme script picks the phone manifest only for small touch screens', async () => {
  const { readdir } = await import('node:fs/promises');
  const file = (await readdir(new URL('../public/shared/', import.meta.url))).find((name) => /^theme\.v[\d.]+\.js$/.test(name));
  const code = await read(`shared/${file}`);
  assert.match(code, /Math\.min\(screen\.width, screen\.height\) < 600/);
  assert.match(code, /phone \? '-phone' : touch \? '-mobile' : ''/);
  assert.match(code, /screen\.orientation\?\.lock/);
});
