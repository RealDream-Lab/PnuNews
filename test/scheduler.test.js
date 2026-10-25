import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { hashPassword } from '../src/auth/crypto.js';
import { createPool } from '../src/db.js';
import { createScheduler } from '../src/scheduler.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig();

test('scheduler publishes due items once and emits after database commit', async () => {
  const pool = createPool(config.db);
  const username = `scheduler-${randomBytes(6).toString('hex')}`;
  const newsIds = [];
  let userId;
  try {
    const [[root]] = await pool.query("SELECT id FROM regions WHERE code = 'IR'");
    const [user] = await pool.execute(
      `INSERT INTO users (username, password_hash, full_name, role, region_id)
       VALUES (?, ?, 'Scheduler test', 'super_admin', ?)`,
      [username, await hashPassword('scheduler-test-password'), root.id],
    );
    userId = user.insertId;

    const [due] = await pool.execute(
      `INSERT INTO news (title, body_html, search_text, status, published_at, origin_region_id,
                        published_by_user_id, publisher_name, publisher_unit, created_by, updated_by)
       VALUES ('Scheduled test', '', 'Scheduled test', 'scheduled', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE), ?, ?, 'Snapshot', 'Unit', ?, ?)`,
      [root.id, userId, userId, userId],
    );
    newsIds.push(due.insertId);
    const [future] = await pool.execute(
      `INSERT INTO news (title, body_html, search_text, status, published_at, origin_region_id,
                        created_by, updated_by)
       VALUES ('Future test', '', 'Future test', 'scheduled', DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 HOUR), ?, ?, ?)`,
      [root.id, userId, userId],
    );
    newsIds.push(future.insertId);
    const [deleted] = await pool.execute(
      `INSERT INTO news (title, body_html, search_text, status, published_at, deleted_at, origin_region_id,
                        created_by, updated_by)
       VALUES ('Deleted test', '', 'Deleted test', 'scheduled', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE), UTC_TIMESTAMP(), ?, ?, ?)`,
      [root.id, userId, userId],
    );
    newsIds.push(deleted.insertId);

    const events = new EventEmitter();
    const received = [];
    events.on('news.published', (event) => received.push(event.id));
    const scheduler = createScheduler(pool, { events });
    assert.deepEqual(await scheduler.runOnce(), [Number(due.insertId)]);
    assert.deepEqual(received, [Number(due.insertId)]);
    assert.deepEqual(await scheduler.runOnce(), []);
    const [rows] = await pool.execute('SELECT id, status FROM news WHERE id IN (?, ?, ?) ORDER BY id', newsIds);
    assert.deepEqual(rows.map((row) => row.status), ['published', 'scheduled', 'scheduled']);
    assert.equal(received.length, 1);
  } finally {
    if (newsIds.length) {
      const placeholders = newsIds.map(() => '?').join(', ');
      await pool.execute(`DELETE FROM news WHERE id IN (${placeholders})`, newsIds);
    }
    if (userId) await pool.execute('DELETE FROM users WHERE id = ?', [userId]);
    await pool.end();
  }
});
