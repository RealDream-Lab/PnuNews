// One-shot import of the automatic portal news, meant to be started by cron / a systemd timer / a Docker scheduler.
//   node scripts/fetch-portal-news.js            respects the on/off switch of the admin panel
//   node scripts/fetch-portal-news.js --force    imports even when the switch is off
// Exit code: 0 = finished (including "nothing new" and "switched off"), 1 = the fetch failed.
import { createPool } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { createPortalImporter } from '../src/portal-news.js';

const force = process.argv.includes('--force');
let exitCode = 0;
let pool;
try {
  const config = loadConfig();
  pool = createPool(config.db);
  const importer = createPortalImporter({ pool, uploadRoot: config.uploadDir });
  const result = await importer.runOnce({ force });
  if (result.disabled) console.info('[portal-news] خبرخوان در پنل مدیریت خاموش است؛ کاری انجام نشد.');
  else if (result.error) {
    console.error(`[portal-news] ناموفق: ${result.error}`);
    exitCode = 1;
  } else console.info(`[portal-news] ${result.created} خبر تازه از ${result.total} خبر بررسی‌شده ثبت شد.`);
} catch (error) {
  console.error(`[portal-news] اجرا ناموفق بود: ${error.message}`);
  exitCode = 1;
} finally {
  await pool?.end().catch(() => {});
}
process.exit(exitCode);
