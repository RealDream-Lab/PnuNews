import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const read = (relative) => readFile(fileURLToPath(new URL(relative, root)), 'utf8');

async function dashboardScript() {
  const files = await readdir(fileURLToPath(new URL('public/dashboard/', root)));
  const name = files.find((file) => /^dashboard\.v[\d.]+\.js$/.test(file));
  assert.ok(name, 'versioned dashboard script exists');
  return read(`public/dashboard/${name}`);
}

test('units list is an accordion: opening a province closes the others', async () => {
  const script = await dashboardScript();
  assert.match(script, /querySelectorAll\("details\[data-province\]\[open\]"\)/);
  assert.match(script, /state\.units\.open = new Set\(\[id\]\)/);
  // a new centre opens only its own province
  assert.match(script, /state\.units\.open = new Set\(\[parentId\]\)/);
});

test('each centre row has an instant password reset and a delete button with two confirmations', async () => {
  const script = await dashboardScript();
  assert.match(script, /data-unit-reset="\$\{city\.id\}"/);
  assert.match(script, /data-unit-delete="\$\{city\.id\}"/);
  const body = script.slice(script.indexOf('async function deleteUnit'), script.indexOf('// ---------- Categories'));
  assert.equal(body.match(/await confirmDialog\(/g)?.length, 2, 'delete asks twice');
  assert.match(body, /method: "DELETE"/);
  assert.match(script, /\/reset-admin-password/);
});

test('region delete and admin password reset are main-admin-only API routes', async () => {
  const source = await read('src/routes/admin.js');
  assert.match(source, /router\.post\('\/regions\/:id\/reset-admin-password'/);
  assert.match(source, /router\.delete\('\/regions\/:id'/);
  for (const marker of ["router.post('/regions/:id/reset-admin-password'", "router.delete('/regions/:id'"]) {
    const start = source.indexOf(marker);
    assert.match(source.slice(start, start + 300), /canManageRegion\(request\.user\)/, `${marker} checks the role`);
  }
  assert.match(source, /region\.type !== 'city'/);
});

test('users list: all provinces on one page as accordions, only one open at a time', async () => {
  const script = await dashboardScript();
  const body = script.slice(script.indexOf('async function loadUsers'), script.indexOf('// Provinces that already have'));
  assert.ok(!body.includes('page:'), 'the users list is not requested page by page');
  assert.match(body, /api\("\/api\/admin\/users"\)/);
  assert.match(body, /<details class=\\"tree-province\\"|<details class="tree-province"/);
  assert.match(script, /querySelectorAll\("details\[data-user-group\]\[open\]"\)/);
  assert.match(script, /state\.usersOpen = new Set\(\[id\]\)/);
});
