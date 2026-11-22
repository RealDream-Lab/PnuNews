import express from 'express';
import { MAX_BOOKMARKS_PER_READER, TOMBSTONE_TTL_MS, mergeBookmarks, parseSyncItems } from '../lib/bookmark-merge.js';
import { createRateLimiter } from '../lib/ratelimit.js';

const toRecord = (row) => ({
  newsId: Number(row.news_id),
  savedAt: Number(row.saved_at),
  deletedAt: row.deleted_at === null || row.deleted_at === undefined ? null : Number(row.deleted_at),
  updatedAt: Number(row.updated_at),
});

const publicRecord = (record) => ({ newsId: record.newsId, savedAt: record.savedAt, deletedAt: record.deletedAt, updatedAt: record.updatedAt });

// The reader's bookmarks on the server, kept in step with the device (see /shared/bookmark-sync). Mounted by the reader
// router, behind its session middleware (`authenticate` sets request.reader). Switching reader signup off (by hand, or by
// itself when the SMS budget runs out) stops only new logins and signups, which need SMS; a reader who is already signed
// in keeps syncing.
export function createBookmarkRouter({ pool, clock = Date.now, authenticate }) {
  const router = express.Router();
  router.use(createRateLimiter({ limit: 30, windowMs: 60_000, clock }));

  router.use(authenticate);
  router.use((request, response, next) => {
    if (request.reader) return next();
    return response.status(401).json({ error: 'ابتدا وارد شوید.', code: 'signIn' });
  });

  async function loadRecords(executor, userId, { lock = false } = {}) {
    const [rows] = await executor.execute(
      `SELECT news_id, saved_at, deleted_at, updated_at FROM reader_bookmarks WHERE user_id = ?${lock ? ' FOR UPDATE' : ''}`,
      [userId],
    );
    return rows.map(toRecord);
  }

  router.get('/', async (request, response, next) => {
    try {
      const records = (await loadRecords(pool, request.reader.id)).sort((a, b) => b.updatedAt - a.updatedAt);
      return response.json({ items: records.map(publicRecord), server_time: clock() });
    } catch (error) {
      return next(error);
    }
  });

  // The device sends everything it has; the answer is the merged truth, which the device then adopts.
  router.post('/sync', async (request, response, next) => {
    const now = clock();
    const parsed = parseSyncItems(request.body, now);
    if (parsed.error) return response.status(400).json({ error: parsed.error });
    try {
      // A bookmark of a news that does not exist (any more) is left out, not an error.
      let items = parsed.items;
      if (items.length) {
        const [found] = await pool.query('SELECT id FROM news WHERE id IN (?)', [items.map((item) => item.newsId)]);
        const existing = new Set(found.map((row) => Number(row.id)));
        items = items.filter((item) => existing.has(item.newsId));
      }
      const connection = await pool.getConnection();
      let merged;
      try {
        await connection.beginTransaction();
        const before = await loadRecords(connection, request.reader.id, { lock: true });
        merged = mergeBookmarks(before, items, { now, cap: MAX_BOOKMARKS_PER_READER });
        if (merged.changed.length) {
          // The comparison is repeated in SQL, so a sync that raced this one cannot be overwritten by an older value.
          await connection.query(
            `INSERT INTO reader_bookmarks (user_id, news_id, saved_at, deleted_at, updated_at) VALUES ?
             ON DUPLICATE KEY UPDATE
               saved_at = IF(VALUES(updated_at) >= updated_at, VALUES(saved_at), saved_at),
               deleted_at = IF(VALUES(updated_at) >= updated_at, VALUES(deleted_at), deleted_at),
               updated_at = GREATEST(updated_at, VALUES(updated_at))`,
            [merged.changed.map((record) => [request.reader.id, record.newsId, record.savedAt, record.deletedAt, record.updatedAt])],
          );
        }
        await connection.execute('DELETE FROM reader_bookmarks WHERE user_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?', [request.reader.id, now - TOMBSTONE_TTL_MS]);
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
      return response.json({ items: merged.records.map(publicRecord), server_time: now });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
