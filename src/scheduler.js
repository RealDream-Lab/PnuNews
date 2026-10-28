import { appEvents, emitNewsPublished } from './events.js';

export function createScheduler(pool, { events = appEvents, intervalMs = 30_000 } = {}) {
  let timer = null;
  let running = false;

  async function runOnce() {
    if (running) return [];
    running = true;
    let connection;
    let publishedIds = [];
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();
      const [due] = await connection.query(
        `SELECT id FROM news
         WHERE status = 'scheduled' AND published_at <= UTC_TIMESTAMP() AND deleted_at IS NULL
         ORDER BY published_at, id FOR UPDATE`,
      );
      publishedIds = due.map((item) => Number(item.id));
      if (publishedIds.length) {
        const placeholders = publishedIds.map(() => '?').join(', ');
        await connection.execute(
          `UPDATE news SET status = 'published', updated_at = UTC_TIMESTAMP()
           WHERE id IN (${placeholders}) AND status = 'scheduled' AND published_at <= UTC_TIMESTAMP() AND deleted_at IS NULL`,
          publishedIds,
        );
      }
      await connection.commit();
    } catch (error) {
      if (connection) await connection.rollback();
      throw error;
    } finally {
      connection?.release();
      running = false;
    }

    for (const id of publishedIds) emitNewsPublished(events, id);
    return publishedIds;
  }

  // Expired sessions, trusted devices and old lockout counters are useless; do not keep them forever.
  async function purgeExpired() {
    await pool.execute('DELETE FROM sessions WHERE expires_at <= UTC_TIMESTAMP()');
    await pool.execute('DELETE FROM trusted_devices WHERE expires_at <= UTC_TIMESTAMP()');
    await pool.execute('DELETE FROM login_attempts WHERE updated_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)');
  }

  function start() {
    if (timer) return;
    let lastPurge = 0;
    timer = setInterval(() => {
      runOnce().catch((error) => console.error(`Scheduler failed: ${error.message}`));
      if (Date.now() - lastPurge >= 60 * 60_000) {
        lastPurge = Date.now();
        purgeExpired().catch((error) => console.error(`Expired-record cleanup failed: ${error.message}`));
      }
    }, intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return { start, stop, runOnce, purgeExpired };
}
