import { createPool } from './src/db.js';
import { createApp } from './src/app.js';
import { loadConfig } from './src/config.js';
import { migrate } from './scripts/migrate.js';

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const pool = createPool(config.db);
await migrate(pool);
const app = createApp({ pool, config });
const server = app.listen(config.port, '0.0.0.0', () => {
  console.info(`PnuNews listening on port ${config.port}`);
});

async function shutdown() {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
