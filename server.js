import { createPool } from './src/db.js';
import { createApp } from './src/app.js';
import { loadConfig } from './src/config.js';
import { migrate } from './scripts/migrate.js';
import { createScheduler } from './src/scheduler.js';
import { createPortalImporter } from './src/portal-news.js';
import { appEvents, emitNewsPublished } from './src/events.js';
import { createStaticAssets } from './src/lib/static.js';
import { createProxyFetch } from './src/lib/http-proxy-fetch.js';
import { createTelegramClient } from './src/lib/telegram.js';
import { createTelegramService } from './src/telegram-publisher.js';
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
// News goes to the users' Telegram channels through the HTTP proxy (TELEGRAM_PROXY, e.g. the v2rayA container) when it
// is set, otherwise through the worker address (or the optional fallback).
const telegram = createTelegramService({
  pool,
  config,
  client: createTelegramClient({
    baseUrl: config.telegramApiBase,
    fallbackUrl: config.telegramApiFallback,
    ...(config.telegramProxy ? { fetchImpl: createProxyFetch(config.telegramProxy) } : {}),
  }),
  uploadRoot: config.uploadDir,
  publicDir: fileURLToPath(new URL('./public/', import.meta.url)),
});
// started before the scheduler so news that falls due at start-up is not missed
telegram.start();
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
const app = createApp({ pool, config, staticAssets, portalImporter, telegram });
const server = app.listen(config.port, '0.0.0.0', () => {
  console.info(`PnuNews listening on port ${config.port}`);
});

async function shutdown() {
  scheduler.stop();
  telegram.stop();
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
