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

test('structure list is an accordion: opening a province closes the others', async () => {
  const script = await dashboardScript();
  assert.match(script, /querySelectorAll\("details\[data-province\]\[open\]"\)/);
  assert.match(script, /state\.units\.open = new Set\(\[id\]\)/);
  // a new centre opens only its own province
  assert.match(script, /state\.units\.open = new Set\(\[parentId\]\)/);
});

test('users and units are one page: «ساختار و کاربران» loads units and users together, in one list', async () => {
  const script = await dashboardScript();
  const html = await read('public/dashboard/index.html');
  const body = script.slice(script.indexOf('async function loadStructure'), script.indexOf('function populateRegionParents'));
  assert.match(body, /api\("\/api\/admin\/regions\/overview"\)/);
  assert.match(body, /api\("\/api\/admin\/users"\)/);
  assert.ok(!body.includes('page:'), 'the list is not requested page by page');
  assert.match(script, /actualView === "users"\) loadStructure\(\)/);
  assert.match(script, /if \(view === "regions"\) view = "users"/, 'the old «regions» view name still lands on the merged page');
  assert.ok(!/data-view="regions"|data-panel="regions"|id="users-tree"|id="users-pager"/.test(html), 'no separate regions/users views remain');
  assert.match(html, /data-panel="users"/);
  assert.match(html, /ساختار و\s+کاربران/);
  // user actions live inside the unit rows
  assert.match(script, /data-user-action="rename"/);
  assert.match(script, /data-user-action="delete"/);
  assert.match(script, /data-unit-add=/);
});

test('each admin has an instant password reset at their own level; centres can be deleted with two confirmations', async () => {
  const script = await dashboardScript();
  assert.match(script, /admin \? "ریست فوری رمز" : "بازنشانی گذرواژه"/);
  assert.match(script, /\/api\/admin\/users\/\$\{id\}\/\$\{action\}/);
  assert.ok(!/reset-admin-password|data-unit-reset/.test(script), 'the per-centre reset is the user reset now');
  assert.match(script, /data-unit-delete="\$\{city\.id\}"/);
  const body = script.slice(script.indexOf('async function deleteUnit'), script.indexOf('// ---------- Categories'));
  assert.equal(body.match(/await confirmDialog\(/g)?.length, 2, 'delete asks twice');
  assert.match(body, /method: "DELETE"/);
});

test('bulk admin creation is gone', async () => {
  const [source, script, html] = [await read('src/routes/admin.js'), await dashboardScript(), await read('public/dashboard/index.html')];
  assert.ok(!/bulk-admins|bulkCreateAdmins|unitsWithoutAdmin|bulkUsername/.test(source + script + html));
});

test('region routes: changing units is main-admin-only; the overview is scoped to the admin\'s own units', async () => {
  const source = await read('src/routes/admin.js');
  assert.ok(!source.includes('reset-admin-password'), 'the per-centre reset route is gone');
  for (const marker of ["router.post('/regions',", "router.patch('/regions/:id'", "router.delete('/regions/:id'"]) {
    const start = source.indexOf(marker);
    assert.ok(start > 0, `${marker} exists`);
    assert.match(source.slice(start, start + 300), /canManageRegion\(request\.user\)/, `${marker} checks the role`);
  }
  assert.match(source, /region\.type !== 'city'/);
  const overview = source.slice(source.indexOf("router.get('/regions/overview'"), source.indexOf("router.post('/regions',"));
  assert.match(overview, /isUnitAdmin\(request\.user\)/, 'unit admins may read their structure');
  assert.match(overview, /unitsInScope\(request\.user/, 'and only the units in their scope');
  assert.match(overview, /isSuper \? \{ \.\.\.unit, users_total/, 'the counts for the delete confirmation are main-admin-only');
});
