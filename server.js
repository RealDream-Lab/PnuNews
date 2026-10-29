import { createPool } from './src/db.js';
import { createApp } from './src/app.js';
import { loadConfig } from './src/config.js';
import { migrate } from './scripts/migrate.js';
import { createScheduler } from './src/scheduler.js';
import { createPortalImporter } from './src/portal-news.js';
import { appEvents, emitNewsPublished } from './src/events.js';
import { createStaticAssets } from './src/lib/static.js';
import { fileURLToPath } from 'node:url';

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const pool = createPool(config.db);
await migrate(pool);
const scheduler = createScheduler(pool);
await scheduler.runOnce();
scheduler.start();
const staticAssets = await createStaticAssets(fileURLToPath(new URL('./public/', import.meta.url)));
const portalImporter = createPortalImporter({ pool, uploadRoot: config.uploadDir });
// PORTAL_FETCH_MODE=external: an OS-level scheduler runs scripts/fetch-portal-news.sh instead of this in-process timer.
if (process.env.PORTAL_FETCH_MODE !== 'external') portalImporter.start();
else {
  console.info('Portal news: external scheduler mode (in-process timer disabled).');
  // The external importer is another process, so this one never sees its events: watch for new rows
  // and tell the cache and the open readers (live updates) about them.
  let lastSeenNewsId = null;
  const watcher = setInterval(async () => {
    try {
      const [rows] = await pool.query('SELECT COALESCE(MAX(id), 0) AS id FROM news WHERE source_url IS NOT NULL');
      const newest = Number(rows[0].id);
      if (lastSeenNewsId !== null && newest > lastSeenNewsId) {
        emitNewsPublished(appEvents, newest);
        appEvents.emit('news.changed', { id: newest });
      }
      lastSeenNewsId = newest;
    } catch (error) {
      console.error(`Portal news watcher failed: ${error.message}`);
    }
  }, 30_000);
  watcher.unref?.();
}
const app = createApp({ pool, config, staticAssets, portalImporter });
const server = app.listen(config.port, '0.0.0.0', () => {
  console.info(`PnuNews listening on port ${config.port}`);
});

async function shutdown() {
  scheduler.stop();
  portalImporter.stop();
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  // Live-update (SSE) connections never end by themselves.
  server.closeAllConnections?.();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
