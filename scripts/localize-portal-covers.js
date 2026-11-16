// Moves the cover pictures of the portal news that are already in the database onto our own server:
// each picture is downloaded from pnu.ac.ir, converted to the 400/800/1280 px WebP set and stored as the news' cover
// attachment (the same as an uploaded cover), so the feed no longer depends on the portal.
//   docker exec -w /workspace/PnuNews nodejs node scripts/localize-portal-covers.js --dry      count only
//   docker exec -w /workspace/PnuNews nodejs node scripts/localize-portal-covers.js            all of them, newest first
//   docker exec -w /workspace/PnuNews nodejs node scripts/localize-portal-covers.js --limit=100
// Safe to stop (Ctrl+C) and to run again: only news that still have no local cover are touched, so a second run
// retries the ones that failed. News whose picture was deleted on the portal (404) cannot be recovered and stay as they are.
// Options: --limit=N   --dry   --delay=ms between pictures (default 300)
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createPool } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { attachCover, localizeCover, removeCoverFiles } from '../src/lib/portal-cover.js';

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, '').split('=');
  return [key, rest.length ? rest.join('=') : true];
}));
const limit = Number.parseInt(args.limit, 10) > 0 ? Number.parseInt(args.limit, 10) : null;
const delayMs = args.delay !== undefined && Number.isFinite(Number(args.delay)) ? Number(args.delay) : 300;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...parts) => console.info('[covers]', ...parts);

// The same .autostart the server reads, when the environment does not already have it (a plain `docker exec` shell).
function loadAutostart() {
  const file = path.resolve(import.meta.dirname, '..', '.autostart');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^export\s+/, '');
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

let pool;
let stopping = false;
process.on('SIGINT', () => { stopping = true; log('توقف پس از عکس فعلی…'); });
let exitCode = 0;
try {
  loadAutostart();
  const config = loadConfig();
  pool = createPool(config.db);
  const [rows] = await pool.query(
    `SELECT id, source_image_url FROM news
     WHERE deleted_at IS NULL AND source_url IS NOT NULL AND cover_attachment_id IS NULL AND source_image_url IS NOT NULL
     ORDER BY id DESC${limit ? ` LIMIT ${limit}` : ''}`,
  );
  log(`${rows.length} خبر پورتال هنوز عکس جلدش روی سرور ما نیست.`);
  if (args.dry || !rows.length) {
    if (args.dry) log('آزمایشی: چیزی تغییر نکرد.');
  } else {
    let done = 0;
    let gone = 0;
    let skipped = 0;
    const failed = [];
    for (const [index, row] of rows.entries()) {
      if (stopping) break;
      let image = null;
      try {
        image = await localizeCover({ url: row.source_image_url, uploadRoot: config.uploadDir });
        const connection = await pool.getConnection();
        try {
          await connection.beginTransaction();
          const [locked] = await connection.execute(
            'SELECT id FROM news WHERE id = ? AND cover_attachment_id IS NULL AND deleted_at IS NULL FOR UPDATE',
            [row.id],
          );
          if (!locked.length) {
            await connection.rollback();
            await removeCoverFiles(image);
            skipped += 1;
          } else {
            await attachCover(connection, row.id, image, row.source_image_url);
            await connection.commit();
            done += 1;
          }
        } catch (error) {
          await connection.rollback();
          throw error;
        } finally {
          connection.release();
        }
      } catch (error) {
        if (image && !(error?.name === 'CoverDownloadError')) await removeCoverFiles(image).catch(() => {});
        if (error?.gone) gone += 1;
        else failed.push(`${row.id}: ${error.message}`);
      }
      if ((index + 1) % 25 === 0) log(`${index + 1} از ${rows.length} بررسی شد (${done} منتقل شد).`);
      await sleep(delayMs);
    }
    log(`${done} عکس جلد به سرور خودمان منتقل شد.`);
    if (gone) log(`${gone} خبر: عکس روی پورتال دیگر وجود ندارد (404) و همان‌طور که بود ماند.`);
    if (skipped) log(`${skipped} خبر در این فاصله عکس یا حذف شد و رد شد.`);
    if (failed.length) {
      log(`${failed.length} خبر ناموفق بود؛ دوباره اجرا کنید تا دوباره تلاش شود:`);
      for (const line of failed.slice(0, 30)) log(`  ${line}`);
      exitCode = 1;
    }
  }
} catch (error) {
  console.error(`[covers] اجرا ناموفق بود: ${error.message}`);
  exitCode = 1;
} finally {
  await pool?.end().catch(() => {});
}
process.exit(exitCode);
