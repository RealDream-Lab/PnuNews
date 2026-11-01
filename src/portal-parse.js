// Normalises the portal news list (from src/portal-scrape.js, or from a JSON source set with PORTAL_NEWS_URL) into
// the items the importer stores.
import { cleanFaText } from './lib/fa.js';

export const PORTAL_BASE_URL = 'https://pnu.ac.ir';

// Only https addresses on pnu.ac.ir are accepted: readers open the links and the server downloads the images.
export function portalUrl(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    const url = new URL(value, PORTAL_BASE_URL);
    if (url.protocol !== 'https:' || !(url.hostname === 'pnu.ac.ir' || url.hostname.endsWith('.pnu.ac.ir'))) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

export function parseProxyNews(payload, limit = 20) {
  if (!payload || payload.error) throw new Error(`پاسخ خطا از منبع خبر: ${payload?.message || 'نامشخص'}`);
  if (!Array.isArray(payload.items)) throw new Error('پاسخ منبع خبر فهرست خبر ندارد.');
  const seen = new Set();
  const items = [];
  for (const raw of payload.items) {
    if (items.length >= limit) break;
    const title = cleanFaText(raw?.title).replace(/\s+/g, ' ');
    const link = portalUrl(raw?.link);
    if (!title || !link || seen.has(link)) continue;
    seen.add(link);
    const timestamp = Number(raw?.timestamp_ms);
    items.push({
      title,
      link,
      image: portalUrl(raw?.image),
      abstract: cleanFaText(raw?.abstract).replace(/\s+/g, ' '),
      timestamp_ms: Number.isFinite(timestamp) && timestamp > 1e11 ? timestamp : null,
    });
  }
  return items;
}
