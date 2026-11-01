// Connectivity check, no database needed: reads the portal news page exactly like the importer does and prints what it found.
//   docker exec -w /workspace/PnuNews nodejs node scripts/check-portal.js
// Exit code: 0 = the list was read, 1 = the portal could not be reached or its page structure changed.
import { parseProxyNews } from '../src/portal-parse.js';
import { PORTAL_SOURCE_URL, fetchPortalPayload } from '../src/portal-scrape.js';

const started = Date.now();
try {
  const payload = await fetchPortalPayload();
  const items = parseProxyNews(payload, 20);
  console.info(`OK: ${items.length} خبر از ${PORTAL_SOURCE_URL} خوانده شد (${Date.now() - started} میلی‌ثانیه).`);
  for (const item of items) {
    const when = item.timestamp_ms ? new Date(item.timestamp_ms).toISOString() : 'بدون تاریخ';
    console.info(`- [${when}] ${item.title}\n  ${item.link}${item.image ? `\n  تصویر: ${item.image}` : ''}`);
  }
} catch (error) {
  console.error(`ناموفق (${Date.now() - started} میلی‌ثانیه): ${error.message}`);
  process.exitCode = 1;
}
