import { createPool } from './src/db.js';
import { createApp } from './src/app.js';
import { loadConfig } from './src/config.js';
import { migrate } from './scripts/migrate.js';
import { createScheduler } from './src/scheduler.js';
import { createPortalImporter } from './src/portal-news.js';
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
portalImporter.start();
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
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
