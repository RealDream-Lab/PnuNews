import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { usernameKey } from '../src/lib/fa.js';

test('usernames that only look different count as the same name', () => {
  const same = [
    ['Ali.Rezaei', 'ali.rezaei'],
    ['علی۱۲', 'علی12'],
    ['كاربر1', 'کاربر1'],
    ['عليرضا', 'علیرضا'],
    ['می\u200cخواهم', 'میخواهم'],
    ['ａｌｉ', 'ali'],
  ];
  for (const [a, b] of same) assert.equal(usernameKey(a), usernameKey(b), `${a} == ${b}`);
  assert.notEqual(usernameKey('c-101'), usernameKey('c-102'));
  assert.notEqual(usernameKey('ali'), usernameKey('ali2'));
});

test('renaming is wired end to end and checked country-wide', async () => {
  const root = new URL('../', import.meta.url);
  const server = await readFile(fileURLToPath(new URL('src/routes/admin.js', root)), 'utf8');
  assert.match(server, /usernameTaken\(connection, username, id\)/, 'rename checks every other user');
  assert.match(server, /usernameTaken\(connection, username, 0\)/, 'create checks too');
  assert.match(server, /GET_LOCK/);
  const dir = fileURLToPath(new URL('public/dashboard/', root));
  const script = (await readdir(dir)).find((file) => /^dashboard\.v[\d.]+\.js$/.test(file));
  const source = await readFile(`${dir}${script}`, 'utf8');
  assert.match(source, /data-user-action="rename"/);
  assert.match(source, /async function renameUser/);
  assert.match(source, /method: "PATCH",\s*body: \{ username: value \}/);
});
