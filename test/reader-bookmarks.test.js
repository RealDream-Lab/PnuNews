import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { createBookmarkRouter } from '../src/routes/reader-bookmarks.js';

const NOW = Date.UTC(2026, 10, 21, 8, 0, 0);
const T0 = NOW - 3600_000;
const t = (n) => T0 + n;

// A database with just what the bookmark routes use: the settings, the news that exist, and reader_bookmarks.
function fakeDatabase({ signupEnabled = true, newsIds = [1, 2, 3, 4, 5], failWrites = false } = {}) {
  const db = { settings: new Map([['reader_signup_enabled', signupEnabled ? '1' : '0']]), news: new Set(newsIds), rows: new Map(), log: { began: 0, committed: 0, rolledBack: 0, released: 0, sql: [] } };
  const key = (userId, newsId) => `${userId}:${newsId}`;
  const select = (userId) => [...db.rows.values()].filter((row) => row.user_id === userId);
  const connection = {
    beginTransaction: async () => { db.log.began += 1; },
    commit: async () => { db.log.committed += 1; },
    rollback: async () => { db.log.rolledBack += 1; },
    release: () => { db.log.released += 1; },
    execute: async (sql, params) => {
      const text = sql.replace(/\s+/g, ' ').trim();
      db.log.sql.push(text);
      if (/^SELECT news_id, saved_at, deleted_at, updated_at FROM reader_bookmarks WHERE user_id = \?/.test(text)) return [select(params[0]).map((row) => ({ ...row })), []];
      if (/^DELETE FROM reader_bookmarks WHERE user_id = \? AND deleted_at IS NOT NULL AND deleted_at < \?$/.test(text)) {
        for (const [k, row] of db.rows) if (row.user_id === params[0] && row.deleted_at !== null && row.deleted_at < params[1]) db.rows.delete(k);
        return [{}, undefined];
      }
      throw new Error(`unhandled execute: ${text}`);
    },
    query: async (sql, params) => {
      const text = sql.replace(/\s+/g, ' ').trim();
      db.log.sql.push(text);
      if (failWrites) throw new Error('disk full');
      if (/^INSERT INTO reader_bookmarks .* VALUES \? ON DUPLICATE KEY UPDATE/.test(text)) {
        for (const [user_id, news_id, saved_at, deleted_at, updated_at] of params[0]) {
          if (!db.news.has(news_id)) throw new Error('foreign key: the news does not exist');
          const current = db.rows.get(key(user_id, news_id));
          if (!current) db.rows.set(key(user_id, news_id), { user_id, news_id, saved_at, deleted_at, updated_at });
          else if (updated_at >= current.updated_at) Object.assign(current, { saved_at, deleted_at, updated_at }); // the same comparison as in the SQL
        }
        return [{}, undefined];
      }
      throw new Error(`unhandled query: ${text}`);
    },
  };
  db.pool = {
    execute: connection.execute,
    getConnection: async () => connection,
    query: async (sql, params) => {
      const text = sql.replace(/\s+/g, ' ').trim();
      if (/^SELECT k, v FROM settings WHERE k IN \(\?\)$/.test(text)) return [[...db.settings].filter(([k]) => params[0].includes(k)).map(([k, v]) => ({ k, v })), []];
      if (/^SELECT id FROM news WHERE id IN \(\?\)$/.test(text)) return [params[0].filter((id) => db.news.has(id)).map((id) => ({ id })), []];
      throw new Error(`unhandled pool query: ${text}`);
    },
  };
  return db;
}

async function withRouter(db, run) {
  const app = express();
  app.use(express.json());
  // The reader session middleware, replaced by a header: x-reader: <id>
  const authenticate = (request, response, next) => { request.reader = request.headers['x-reader'] ? { id: Number(request.headers['x-reader']) } : null; next(); };
  app.use('/api/reader/bookmarks', createBookmarkRouter({ pool: db.pool, clock: () => NOW, authenticate }));
  app.use((error, request, response, next) => response.status(500).json({ error: 'x' }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const call = (path, { method = 'GET', body, reader } = {}) => new Promise((resolve, reject) => {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (reader) headers['x-reader'] = String(reader);
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const sync = (reader, items) => call('/api/reader/bookmarks/sync', { method: 'POST', body: { items }, reader });
  try {
    return await run({ call, sync });
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
}

const item = (newsId, savedAt, deletedAt = null) => ({ newsId, savedAt: t(savedAt), deletedAt: deletedAt === null ? null : t(deletedAt) });
const shape = (items) => items.map((i) => [i.newsId, i.deletedAt === null ? 'live' : 'removed']).sort((a, b) => a[0] - b[0]);

test('signup off: 403 for everyone and nothing is read or written; on, a reader who is not signed in gets 401', async () => {
  const off = fakeDatabase({ signupEnabled: false });
  await withRouter(off, async ({ call, sync }) => {
    for (const reader of [undefined, 1]) {
      const response = await call('/api/reader/bookmarks', { reader });
      assert.equal(response.status, 403);
      assert.equal(response.json.code, 'disabled');
      assert.equal((await sync(reader, [item(1, 10)])).status, 403);
    }
  });
  assert.equal(off.rows.size, 0);
  assert.equal(off.log.began, 0);
  const on = fakeDatabase();
  await withRouter(on, async ({ call, sync }) => {
    assert.equal((await call('/api/reader/bookmarks')).status, 401);
    assert.equal((await sync(undefined, [item(1, 10)])).status, 401);
  });
  assert.equal(on.log.began, 0);
});

test('a device sends what it has and gets the merged list; news that do not exist are left out; readers are separate', async () => {
  const db = fakeDatabase();
  await withRouter(db, async ({ call, sync }) => {
    assert.deepEqual((await call('/api/reader/bookmarks', { reader: 1 })).json.items, []);
    const first = await sync(1, [item(1, 10), item(2, 20), item(99, 30)]);
    assert.equal(first.status, 200);
    assert.deepEqual(shape(first.json.items), [[1, 'live'], [2, 'live']], 'news 99 does not exist');
    assert.equal(first.json.server_time, NOW);
    assert.deepEqual(first.json.items.map((i) => i.newsId), [2, 1], 'newest change first');
    assert.deepEqual(Object.keys(first.json.items[0]).sort(), ['deletedAt', 'newsId', 'savedAt', 'updatedAt']);
    assert.equal(first.json.items[0].updatedAt, t(20));
    assert.deepEqual(shape((await call('/api/reader/bookmarks', { reader: 1 })).json.items), [[1, 'live'], [2, 'live']]);
    assert.deepEqual((await call('/api/reader/bookmarks', { reader: 2 })).json.items, [], 'another reader sees nothing of it');
    const other = await sync(2, [item(3, 5)]);
    assert.deepEqual(shape(other.json.items), [[3, 'live']]);
  });
  assert.deepEqual([db.log.began, db.log.committed, db.log.rolledBack, db.log.released], [2, 2, 0, 2]);
  assert.ok(db.log.sql.some((text) => /FOR UPDATE$/.test(text)), 'the reader\'s rows are locked while merging');
  assert.ok(db.log.sql.some((text) => text.includes('IF(VALUES(updated_at) >= updated_at, VALUES(saved_at), saved_at)')), 'the newest-wins comparison is also in the SQL');
});

test('two devices: a removal travels, an old copy does not undo it, saving again does', async () => {
  const db = fakeDatabase();
  await withRouter(db, async ({ sync }) => {
    await sync(1, [item(1, 10), item(2, 20)]); // device A
    const b = await sync(1, [item(2, 20, 40), item(3, 30)]); // device B removed 2 and saved 3
    assert.deepEqual(shape(b.json.items), [[1, 'live'], [2, 'removed'], [3, 'live']]);
    const aAgain = await sync(1, [item(1, 10), item(2, 20)]); // device A has not heard yet
    assert.deepEqual(shape(aAgain.json.items), [[1, 'live'], [2, 'removed'], [3, 'live']], 'the old copy of 2 does not bring it back');
    assert.equal(aAgain.json.items.find((i) => i.newsId === 2).deletedAt, t(40), 'and A is told it was removed');
    const saved = await sync(1, [item(2, 50)]); // A saves 2 again, later
    assert.deepEqual(shape(saved.json.items), [[1, 'live'], [2, 'live'], [3, 'live']]);
    const same = await sync(1, [item(2, 50)]);
    assert.deepEqual(shape(same.json.items), [[1, 'live'], [2, 'live'], [3, 'live']]);
  });
  assert.equal(db.rows.get('1:2').deleted_at, null);
});

test('a malformed request is refused before the database is touched', async () => {
  const db = fakeDatabase();
  await withRouter(db, async ({ call }) => {
    for (const body of [{}, { items: 'x' }, { items: [null] }, { items: [{ newsId: 1 }] }, { items: [{ newsId: 'x', savedAt: 5 }] },
      { items: [{ newsId: 1, savedAt: t(10), deletedAt: t(5) }] }, { items: Array.from({ length: 1501 }, (_, i) => ({ newsId: i + 1, savedAt: t(10) })) }]) {
      const response = await call('/api/reader/bookmarks/sync', { method: 'POST', body, reader: 1 });
      assert.equal(response.status, 400, JSON.stringify(body).slice(0, 60));
      assert.ok(response.json.error);
    }
  });
  assert.equal(db.log.began, 0);
  assert.equal(db.rows.size, 0);
});

test('a failed write is rolled back and reported, and the connection is always released', async () => {
  const db = fakeDatabase({ failWrites: true });
  await withRouter(db, async ({ sync }) => {
    assert.equal((await sync(1, [item(1, 10)])).status, 500);
  });
  assert.deepEqual([db.log.began, db.log.committed, db.log.rolledBack, db.log.released], [1, 0, 1, 1]);
  assert.equal(db.rows.size, 0);
});

test('more than 500 live bookmarks: the newest 500 stay, the oldest become tombstones that every device learns of', async () => {
  const db = fakeDatabase({ newsIds: Array.from({ length: 600 }, (_, i) => i + 1) });
  await withRouter(db, async ({ sync }) => {
    const items = Array.from({ length: 502 }, (_, i) => item(i + 1, i + 1));
    const answer = await sync(1, items);
    assert.equal(answer.status, 200);
    const live = answer.json.items.filter((i) => i.deletedAt === null);
    const removed = answer.json.items.filter((i) => i.deletedAt !== null);
    assert.equal(live.length, 500);
    assert.deepEqual(removed.map((i) => i.newsId).sort((a, b) => a - b), [1, 2], 'the two saved first');
    assert.ok(removed.every((i) => i.deletedAt === NOW && i.deletedAt > i.savedAt));
    // the device that still has all 502 gets the same answer next time and does not push them back
    const again = await sync(1, items);
    assert.equal(again.json.items.filter((i) => i.deletedAt === null).length, 500);
  });
});

test('tombstones older than 90 days are deleted from the database during a sync', async () => {
  const db = fakeDatabase();
  const old = NOW - 91 * 24 * 3600_000;
  db.rows.set('1:4', { user_id: 1, news_id: 4, saved_at: old - 10, deleted_at: old, updated_at: old });
  db.rows.set('1:5', { user_id: 1, news_id: 5, saved_at: old - 10, deleted_at: NOW - 1000, updated_at: NOW - 1000 });
  await withRouter(db, async ({ sync }) => {
    const answer = await sync(1, []);
    assert.deepEqual(answer.json.items.map((i) => i.newsId), [5], 'an old tombstone is not even reported');
  });
  assert.equal(db.rows.has('1:4'), false);
  assert.equal(db.rows.has('1:5'), true);
});
