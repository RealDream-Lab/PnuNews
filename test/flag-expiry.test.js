import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createScheduler } from '../src/scheduler.js';
import { FLAG_LIFETIME_HOURS, FLAG_LIFETIME_MS, flagsHaveExpired } from '../src/news/flag-expiry.js';

const root = fileURLToPath(new URL('..', import.meta.url));

test('important and urgent last 72 hours from publication', () => {
  assert.equal(FLAG_LIFETIME_HOURS, 72);
  const published = Date.parse('2026-11-10T08:00:00Z');
  assert.equal(flagsHaveExpired(new Date(published), published + FLAG_LIFETIME_MS - 1), false);
  assert.equal(flagsHaveExpired(new Date(published), published + FLAG_LIFETIME_MS), true);
  assert.equal(flagsHaveExpired(null), false, 'a draft has no publication time');
  assert.equal(flagsHaveExpired(new Date(published + 3600_000), published), false, 'a scheduled news has not started yet');
});

function fakePool({ dueIds = [] } = {}) {
  const log = [];
  const connection = {
    async beginTransaction() { log.push('begin'); },
    async commit() { log.push('commit'); },
    async rollback() { log.push('rollback'); },
    release() { log.push('release'); },
    async query(sql) {
      log.push({ sql });
      // runOnce looks for scheduled news first; only the flag query returns rows here
      return [/is_pinned = 1 OR is_urgent = 1/.test(sql) ? dueIds.map((id) => ({ id })) : []];
    },
    async execute(sql, params) { log.push({ sql, params }); return [{}]; },
  };
  return { log, pool: { getConnection: async () => connection } };
}

test('the scheduler turns old important/urgent news back into ordinary news and tells readers', async () => {
  const { pool, log } = fakePool({ dueIds: [5, 9] });
  const events = new EventEmitter();
  const changed = [];
  events.on('news.changed', (event) => changed.push(event.id));
  const ids = await createScheduler(pool, { events }).expireFlags();
  assert.deepEqual(ids, [5, 9]);
  assert.deepEqual(changed, [5, 9]);
  const select = log.find((entry) => entry.sql?.includes('is_pinned = 1 OR is_urgent = 1')).sql;
  assert.match(select, /status = 'published'/);
  assert.match(select, /published_at <= DATE_SUB\(UTC_TIMESTAMP\(\), INTERVAL 72 HOUR\)/);
  const update = log.find((entry) => entry.sql?.startsWith('UPDATE news SET is_pinned = 0, is_urgent = 0'));
  assert.deepEqual(update.params, [5, 9]);
  assert.ok(log.includes('commit') && log.includes('release'));
});

test('nothing is written or announced when no news has expired', async () => {
  const { pool, log } = fakePool({ dueIds: [] });
  const events = new EventEmitter();
  let announced = 0;
  events.on('news.changed', () => { announced += 1; });
  assert.deepEqual(await createScheduler(pool, { events }).expireFlags(), []);
  assert.equal(announced, 0);
  assert.equal(log.some((entry) => entry.sql?.startsWith('UPDATE news SET is_pinned = 0')), false);
});

test('the regular tick runs it, and a failure there cannot stop publishing', async () => {
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async query(sql) { if (sql.includes('is_pinned = 1')) throw new Error('db down'); return [[]]; },
    async execute() { return [{}]; },
  };
  const errors = [];
  const original = console.error;
  console.error = (message) => errors.push(message);
  try {
    assert.deepEqual(await createScheduler({ getConnection: async () => connection }, { events: new EventEmitter() }).runOnce(), []);
  } finally {
    console.error = original;
  }
  assert.ok(errors.some((message) => message.includes('db down')));
});

test('the admin API refuses to make an already old published news important or urgent', () => {
  const admin = readFileSync(`${root}src/routes/news-admin.js`, 'utf8');
  assert.match(admin, /enabled && context\.news\.status === 'published' && flagsHaveExpired\(context\.news\.published_at, clock\(\)\)/);
});
