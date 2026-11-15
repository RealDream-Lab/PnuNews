// Diagnoses blank covers of the automatic portal news, from the machine the site runs on:
//   docker exec -w /workspace/PnuNews nodejs node scripts/check-news-images.js            latest 40 portal news
//   docker exec -w /workspace/PnuNews nodejs node scripts/check-news-images.js --limit=100
//   docker exec -w /workspace/PnuNews nodejs node scripts/check-news-images.js --json     the same report as JSON
// For every portal news it takes the stored cover address (news.source_image_url), asks for it the way a browser
// would (no Referer) and tells what came back. When the news is still in the portal's current list it also compares the
// stored address with the one the portal shows now. Nothing is written to the database.
import { pathToFileURL } from 'node:url';
import { createPool } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { parsePortalHtml, fetchPortalHtml } from '../src/portal-scrape.js';

const USER_AGENT = 'Mozilla/5.0 (compatible; PNU-News-Reader/1.0)';

// What the reader's Content-Security-Policy lets a browser load (src/app.js: img-src ... https://pnu.ac.ir).
export function cspAllows(address) {
  try {
    const url = new URL(address);
    return url.protocol === 'https:' && url.hostname === 'pnu.ac.ir';
  } catch {
    return false;
  }
}

// One request for the image, without a Referer, reading only the first bytes.
export async function probeImage(address, fetchImpl = fetch) {
  const result = { status: null, content_type: null, bytes: 0, final_url: null, error: null };
  try {
    const response = await fetchImpl(address, {
      headers: { 'user-agent': USER_AGENT, accept: 'image/avif,image/webp,image/*,*/*;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });
    result.status = response.status;
    result.content_type = response.headers.get('content-type');
    result.final_url = response.url && response.url !== address ? response.url : null;
    const reader = response.body?.getReader();
    if (reader) {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        result.bytes += value.length;
        if (result.bytes >= 4096) break;
      }
      await reader.cancel().catch(() => {});
    }
  } catch (error) {
    result.error = `${error.cause?.code || error.name}: ${error.message}`;
  }
  return result;
}

// One verdict per news, in the order a problem is most likely to be found.
export function verdict(row, probe, portalImage) {
  if (!row.source_image_url) return 'بدون نشانی تصویر';
  if (!cspAllows(row.source_image_url)) return 'نشانی خارج از مجاز CSP است (فقط https://pnu.ac.ir)';
  if (probe.error) return `دریافت نشد (${probe.error})`;
  if (probe.status >= 400) return `سرور پورتال ${probe.status} داد`;
  if (!String(probe.content_type ?? '').toLowerCase().startsWith('image/')) return `پاسخ تصویر نیست (${probe.content_type || 'بدون نوع'})`;
  if (probe.bytes === 0) return 'پاسخ خالی است';
  if (portalImage && portalImage !== row.source_image_url) return 'سالم است ولی پورتال حالا نشانی دیگری دارد';
  return 'سالم';
}

async function main() {
  const asJson = process.argv.includes('--json');
  const limit = Math.min(500, Math.max(1, Number(process.argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1]) || 40));
  const pool = createPool(loadConfig().db);
  try {
    const [rows] = await pool.query(
      `SELECT id, title, published_at, source_url, source_image_url, cover_attachment_id
       FROM news WHERE source_hash IS NOT NULL ORDER BY published_at DESC, id DESC LIMIT ?`,
      [limit],
    );
    let current = new Map();
    let portalError = null;
    try {
      current = new Map(parsePortalHtml(await fetchPortalHtml(), 50).map((item) => [String(item.link).toLowerCase(), item.image]));
    } catch (error) {
      portalError = error.message;
    }
    const report = [];
    const queue = [...rows];
    await Promise.all(Array.from({ length: 5 }, async () => {
      for (let row = queue.shift(); row; row = queue.shift()) {
        const probe = row.source_image_url && cspAllows(row.source_image_url) ? await probeImage(row.source_image_url) : { status: null, content_type: null, bytes: 0, final_url: null, error: null };
        const inList = current.has(String(row.source_url).toLowerCase());
        const portalImage = inList ? current.get(String(row.source_url).toLowerCase()) : undefined;
        report.push({
          id: Number(row.id),
          published_at: row.published_at.toISOString(),
          title: row.title,
          verdict: verdict(row, probe, portalImage),
          in_portal_list: inList,
          stored_image: row.source_image_url,
          portal_image_now: portalImage ?? null,
          has_own_cover: row.cover_attachment_id != null,
          probe,
        });
      }
    }));
    report.sort((a, b) => b.id - a.id);
    if (asJson) {
      console.info(JSON.stringify({ portal_error: portalError, report }, null, 2));
      return;
    }
    if (portalError) console.info(`هشدار: فهرست فعلی پورتال خوانده نشد (${portalError}).`);
    const counts = {};
    for (const entry of report) counts[entry.verdict] = (counts[entry.verdict] ?? 0) + 1;
    for (const entry of report) {
      console.info(`#${entry.id} ${entry.in_portal_list ? '[در فهرست فعلی پورتال]' : '[خارج از فهرست پورتال]'} ${entry.verdict}\n  ${entry.title.slice(0, 70)}\n  ذخیره‌شده: ${entry.stored_image ?? '—'}${entry.portal_image_now && entry.portal_image_now !== entry.stored_image ? `\n  حالا در پورتال: ${entry.portal_image_now}` : ''}`);
    }
    console.info('\nخلاصه:');
    for (const [name, count] of Object.entries(counts)) console.info(`  ${count} × ${name}`);
  } finally {
    await pool.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`اجرا ناموفق بود: ${error.message}`);
    process.exitCode = 1;
  });
}
