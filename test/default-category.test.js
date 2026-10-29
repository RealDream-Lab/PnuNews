import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CATEGORY_NAME, ensureDefaultCategory } from '../src/news/default-category.js';

// A tiny stand-in for the pool: `categories` is the table, queries are recognised by their SQL.
function fakePool(categories, { dupOnInsert = false } = {}) {
  const table = categories.map((row) => ({ ...row }));
  return {
    table,
    async execute(sql, params = []) {
      if (sql.startsWith('SELECT id, is_active FROM categories WHERE name')) return [table.filter((row) => row.name === params[0])];
      if (sql.includes('WHERE is_active = 1 ORDER BY sort_order')) return [table.filter((row) => row.is_active).sort((a, b) => a.sort_order - b.sort_order || a.id - b.id).slice(0, 1)];
      if (sql.startsWith('UPDATE categories SET is_active = 1')) { table.find((row) => row.id === params[0]).is_active = 1; return [{}]; }
      if (sql.startsWith('INSERT INTO categories')) {
        if (dupOnInsert) { table.push({ id: 99, name: params[0], sort_order: 9, is_active: 1 }); throw Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' }); }
        const id = Math.max(0, ...table.map((row) => row.id)) + 1;
        table.push({ id, name: params[0], sort_order: 1, is_active: 1 });
        return [{ insertId: id }];
      }
      if (sql.startsWith('SELECT id FROM categories WHERE name')) return [table.filter((row) => row.name === params[0])];
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

test('an active "اخبار" category is used as it is', async () => {
  const pool = fakePool([{ id: 7, name: DEFAULT_CATEGORY_NAME, sort_order: 3, is_active: 1 }]);
  assert.deepEqual(await ensureDefaultCategory(pool), { id: 7, created: false });
});

test('the category is created when it does not exist, even if others do', async () => {
  const pool = fakePool([{ id: 2, name: 'آموزشی', sort_order: 1, is_active: 1 }]);
  const result = await ensureDefaultCategory(pool);
  assert.equal(result.created, true);
  assert.equal(pool.table.find((row) => row.id === result.id).name, DEFAULT_CATEGORY_NAME);
});

test('a category an administrator switched off stays off while another active one exists', async () => {
  const pool = fakePool([{ id: 1, name: DEFAULT_CATEGORY_NAME, sort_order: 1, is_active: 0 }, { id: 2, name: 'آموزشی', sort_order: 2, is_active: 1 }]);
  assert.deepEqual(await ensureDefaultCategory(pool), { id: 2, created: false });
  assert.equal(pool.table[0].is_active, 0);
});

test('with no active category left, "اخبار" is switched back on', async () => {
  const pool = fakePool([{ id: 1, name: DEFAULT_CATEGORY_NAME, sort_order: 1, is_active: 0 }]);
  assert.deepEqual(await ensureDefaultCategory(pool), { id: 1, created: false });
  assert.equal(pool.table[0].is_active, 1);
});

test('a duplicate created at the same moment is reused', async () => {
  const pool = fakePool([], { dupOnInsert: true });
  assert.deepEqual(await ensureDefaultCategory(pool), { id: 99, created: false });
});
