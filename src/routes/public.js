import { createHash } from 'node:crypto';
import express from 'express';
import { appEvents } from '../events.js';

import { createMicroCache } from '../lib/microcache.js';
import { createRateLimiter } from '../lib/ratelimit.js';
import { normalizeBrandName } from '../lib/fa.js';
import { fetchNowPlaying, makeRadioResolver, resolveNowPlayingUrl } from '../lib/nowplaying.js';
import { sanitizeBodyHtml } from '../news/content.js';
import { sortCategoriesByNewsCount } from '../news/category-order.js';

const FEED_SCOPES = new Set(['all', 'country', 'province', 'city']);
const VIEW_DEDUPE_MS = 30 * 60_000;
const VIEW_DEDUPE_LIMIT = 50_000;
const LIVE_CLIENT_LIMIT = 2000;
// Generous on purpose: a whole campus can sit behind one NAT address.
const LIVE_CLIENT_LIMIT_PER_IP = 50;
const faCollator = new Intl.Collator('fa', { sensitivity: 'base' });

function idValue(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function encodeCursor(item) {
  return Buffer.from(JSON.stringify({ published_at: item.published_at.toISOString(), id: Number(item.id) })).toString('base64url');
}

function decodeCursor(value) {
  if (typeof value !== 'string' || value.length > 256) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    const id = idValue(parsed.id);
    const publishedAt = new Date(parsed.published_at);
    if (!id || !Number.isFinite(publishedAt.getTime()) || publishedAt.toISOString() !== parsed.published_at) return null;
    return { id, publishedAt };
  } catch {
    return null;
  }
}

function imageUrls(storedName) {
  if (typeof storedName !== 'string' || !/^img\/\d{4}\/(0[1-9]|1[0-2])\/[a-f\d]{32}$/i.test(storedName)) return null;
  return {
    src: `/media/${storedName}-800.webp`,
    srcset: [400, 800, 1280].map((width) => `/media/${storedName}-${width}.webp ${width}w`).join(', '),
  };
}

// Cover used when a news item has no uploaded cover (and no imported source image): one per news type.
const DEFAULT_COVERS = {
  news: { name: 'default-news', dominant_color: '#a0a6ab' },
  announcement: { name: 'default-announcement', dominant_color: '#93979d' },
};

function defaultCover(newsType) {
  const { name, dominant_color: dominantColor } = DEFAULT_COVERS[newsType] ?? DEFAULT_COVERS.news;
  return {
    src: `/covers/${name}.v1.800.webp`,
    srcset: [400, 800, 1280].map((width) => `/covers/${name}.v1.${width}.webp ${width}w`).join(', '),
    dominant_color: dominantColor,
    width: 1280,
    height: 720,
    is_default: true,
  };
}

function plainString(value, maxLength = 200) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength) : '';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function publicItem(row) {
  const image = imageUrls(row.cover_stored_name);
  const external = !image && row.source_image_url ? { src: row.source_image_url, srcset: '', external: true } : null;
  return {
    id: Number(row.id),
    title: row.title,
    summary: row.summary,
    news_type: row.news_type === 'announcement' ? 'announcement' : 'news',
    category: row.category_id == null ? null : { id: Number(row.category_id), name: row.category_name },
    published_at: row.published_at.toISOString(),
    expires_at: row.expires_at?.toISOString() ?? null,
    is_pinned: Boolean(row.is_pinned),
    is_urgent: Boolean(row.is_urgent),
    view_count: Number(row.view_count),
    publisher_name: row.publisher_name,
    publisher_unit: row.publisher_unit,
    source_url: row.source_url || null,
    scope: { type: row.scope_type, id: Number(row.scope_region_id), name: row.scope_name },
    cover: image ? { ...image, dominant_color: row.cover_dominant_color, width: row.cover_width, height: row.cover_height } : (external ?? defaultCover(row.news_type)),
  };
}

async function settingsMap(pool, keys) {
  const [rows] = await pool.query(`SELECT k, v FROM settings WHERE k IN (${keys.map(() => '?').join(',')})`, keys);
  return Object.fromEntries(rows.map((row) => [row.k, row.v]));
}

async function loadVisibleCity(pool, cityId) {
  const [rows] = await pool.execute(
    `SELECT city.id, city.name, city.parent_id AS province_id, province.name AS province_name,
            country.id AS country_id
     FROM regions city
     JOIN regions province ON province.id = city.parent_id AND province.type = 'province'
     JOIN regions country ON country.type = 'country' AND country.parent_id IS NULL
     WHERE city.id = ? AND city.type = 'city' AND city.visibility_override <> 'hide'
       AND (city.visibility_override = 'show' OR EXISTS (
         SELECT 1 FROM users u WHERE u.region_id = city.id AND u.role = 'city_admin' AND u.is_active = 1
       ))
     LIMIT 1`,
    [cityId],
  );
  return rows[0] ?? null;
}

async function visibleRegions(pool) {
  const [provinceRows] = await pool.query(
    `SELECT id, name FROM regions WHERE type = 'province' AND visibility_override <> 'hide'`,
  );
  const [cityRows] = await pool.query(
    `SELECT city.id AS city_id, city.name AS city_name, city.parent_id AS province_id
     FROM regions city
     WHERE city.type = 'city' AND city.visibility_override <> 'hide'
       AND (city.visibility_override = 'show' OR EXISTS (
         SELECT 1 FROM users u WHERE u.region_id = city.id AND u.role = 'city_admin' AND u.is_active = 1
       ))`,
  );
  const provinces = new Map(provinceRows.map((row) => [Number(row.id), { id: Number(row.id), name: row.name, cities: [] }]));
  for (const row of cityRows) {
    provinces.get(Number(row.province_id))?.cities.push({ id: Number(row.city_id), name: row.city_name });
  }
  return [...provinces.values()]
    .map((province) => ({ ...province, cities: province.cities.sort((left, right) => faCollator.compare(left.name, right.name)) }))
    .sort((left, right) => faCollator.compare(left.name, right.name));
}

// Other visible university centers of the reader's own province.
async function siblingCityIds(pool, city) {
  const [rows] = await pool.execute(
    `SELECT sibling.id FROM regions sibling
     WHERE sibling.type = 'city' AND sibling.parent_id = ? AND sibling.id <> ? AND sibling.visibility_override <> 'hide'
       AND (sibling.visibility_override = 'show' OR EXISTS (
         SELECT 1 FROM users u WHERE u.region_id = sibling.id AND u.role = 'city_admin' AND u.is_active = 1
       ))`,
    [city.province_id, city.id],
  );
  return rows.map((row) => Number(row.id));
}

// The reader's own center is always included; national, provincial and sibling-center news are the reader's choice.
async function feedRegionIds(pool, city, { country, province, siblings }) {
  const ids = [Number(city.id)];
  if (country) ids.push(Number(city.country_id));
  if (province) ids.push(Number(city.province_id));
  if (siblings) ids.push(...await siblingCityIds(pool, city));
  return ids;
}

// News the reader's center can see: published, already due, not deleted/expired, aimed at one of regionIds
// (and, when a scope is chosen, also aimed at a region of that type). Shared by the feed and the category counts.
function visibleNewsFilters(regionIds, scope) {
  const marks = regionIds.map(() => '?').join(', ');
  const filters = [
    "n.status = 'published'",
    'n.published_at <= UTC_TIMESTAMP()',
    'n.deleted_at IS NULL',
    '(n.expires_at IS NULL OR n.expires_at > UTC_TIMESTAMP())',
    `EXISTS (SELECT 1 FROM news_targets visible_target WHERE visible_target.news_id = n.id AND visible_target.region_id IN (${marks}))`,
  ];
  const values = [...regionIds];
  if (scope !== 'all') {
    filters.push(`EXISTS (
      SELECT 1 FROM news_targets scope_target JOIN regions scope_region ON scope_region.id = scope_target.region_id
      WHERE scope_target.news_id = n.id AND scope_region.type = ?
    )`);
    values.push(scope);
  }
  return { filters, values };
}

// Active categories that have at least one visible news item for this reader, with that count.
async function visibleCategoryCounts(pool, regionIds, scope) {
  const { filters, values } = visibleNewsFilters(regionIds, scope);
  const [rows] = await pool.execute(
    `SELECT c.id, c.name, COUNT(*) AS news_count
     FROM news n JOIN categories c ON c.id = n.category_id AND c.is_active = 1
     WHERE ${filters.join(' AND ')}
     GROUP BY c.id, c.name`,
    values,
  );
  return sortCategoriesByNewsCount(rows).map((row) => ({ id: Number(row.id), name: row.name, news_count: Number(row.news_count) || 0 }));
}

async function feedRows(pool, city, { scope, cursor, limit, regionIds, categoryId = null, pinned = false }) {
  const marks = regionIds.map(() => '?').join(', ');
  const { filters, values } = visibleNewsFilters(regionIds, scope);
  if (categoryId) {
    filters.push('n.category_id = ?');
    values.push(categoryId);
  }
  if (pinned) filters.push('(n.is_pinned = 1 OR n.is_urgent = 1)');
  if (cursor) {
    filters.push('(n.published_at < ? OR (n.published_at = ? AND n.id < ?))');
    values.push(cursor.publishedAt, cursor.publishedAt, cursor.id);
  }

  const [rows] = await pool.execute(
    `SELECT n.id, n.title, n.summary, n.news_type, n.category_id, c.name AS category_name,
            n.published_at, n.expires_at, n.is_pinned, n.is_urgent, n.view_count,
            n.publisher_name, n.publisher_unit, n.source_url,
            n.source_image_url, cover.stored_name AS cover_stored_name, cover.width AS cover_width,
            cover.height AS cover_height, cover.dominant_color AS cover_dominant_color,
            matched.id AS scope_region_id, matched.type AS scope_type, matched.name AS scope_name
     FROM news n
     LEFT JOIN categories c ON c.id = n.category_id
     LEFT JOIN attachments cover ON cover.id = n.cover_attachment_id
     LEFT JOIN regions matched ON matched.id = (
       SELECT target.region_id FROM news_targets target JOIN regions target_region ON target_region.id = target.region_id
       WHERE target.news_id = n.id AND target.region_id IN (${marks})
       ORDER BY FIELD(target_region.type, 'country', 'province', 'city'), (target.region_id = ?) DESC, target.region_id LIMIT 1
     )
     WHERE ${filters.join(' AND ')}
     ORDER BY ${pinned ? 'n.is_urgent DESC, n.is_pinned DESC, ' : ''}n.published_at DESC, n.id DESC
     LIMIT ?`,
    [...regionIds, Number(city.id), ...values, limit + (pinned ? 0 : 1)],
  );
  return rows;
}

function injectOpenGraph(shell, { title, summary, image, canonical, siteTitle }) {
  const titleTag = `<title>${escapeHtml(title)} — ${escapeHtml(siteTitle)}</title>`;
  const descriptionTag = `<meta name="description" content="${escapeHtml(summary)}">`;
  const metadata = [
    '<meta property="og:type" content="article">',
    `<meta property="og:site_name" content="${escapeHtml(siteTitle)}">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(summary)}">`,
    `<meta property="og:url" content="${escapeHtml(canonical)}">`,
    `<link rel="canonical" href="${escapeHtml(canonical)}">`,
    image ? `<meta property="og:image" content="${escapeHtml(image)}"><meta name="twitter:image" content="${escapeHtml(image)}"><meta name="twitter:card" content="summary_large_image">` : '<meta name="twitter:card" content="summary">',
    `<meta name="twitter:title" content="${escapeHtml(title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(summary)}">`,
  ].join('\n');
  // Function replacers: a string replacement would interpret `$&`, `$\`` etc. inside the (admin-written) title.
  return shell
    .replace(/<title>[\s\S]*?<\/title>/i, () => titleTag)
    .replace(/<meta name="description"[^>]*>/i, () => descriptionTag)
    .replace('</head>', () => `${metadata}\n</head>`);
}

function makeHtmlShell({ title, summary, image, canonical, siteTitle }) {
  const imageMeta = image
    ? `<meta property="og:image" content="${escapeHtml(image)}"><meta name="twitter:image" content="${escapeHtml(image)}"><meta name="twitter:card" content="summary_large_image">`
    : '<meta name="twitter:card" content="summary">';
  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#f4f7fb">
<title>${escapeHtml(title)} — ${escapeHtml(siteTitle)}</title>
<meta name="description" content="${escapeHtml(summary)}">
<link rel="canonical" href="${escapeHtml(canonical)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="${escapeHtml(siteTitle)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(summary)}">
<meta property="og:url" content="${escapeHtml(canonical)}">
${imageMeta}
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(summary)}">
<link rel="stylesheet" href="/reader/styles.v0.1.50.css">
<script src="/shared/theme.v0.1.50.js"></script>
</head>
<body>
<main id="app" class="reader-app"><header class="site-header"><a href="/">${escapeHtml(siteTitle)}</a></header><article class="news-page"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(summary)}</p><p>برای مشاهدهٔ کامل خبر، برنامهٔ مرورگر خود را به‌روز کنید.</p></article></main>
<script type="module" src="/reader/app.v0.1.50.js"></script>
</body>
</html>`;
}

export function createPublicRouter({ pool, config, clock = Date.now, fetchImpl = fetch, events = appEvents, staticAssets }) {
  const router = express.Router();
  const cache = createMicroCache({ ttlMs: 15_000, maxEntries: 1000, clock });
  const rateLimit = createRateLimiter({ limit: 120, windowMs: 60_000, clock });
  const viewDedupe = new Map();
  let radioCache = { url: '', expiresAt: 0, value: null };
  const clearCaches = () => {
    cache.clear();
    radioCache = { url: '', expiresAt: 0, value: null };
  };
  events.on('news.changed', clearCaches);
  events.on('news.published', clearCaches);
  events.on('settings.changed', clearCaches);
  events.on('regions.changed', clearCaches);
  router.use(['/api/public', '/n'], rateLimit);

  // Live channel: tells open readers that the feed changed so they can refetch the first page and animate it in.
  // The event carries no news data (readers refetch through the normal, cached feed endpoint).
  const liveClients = new Set();
  let liveVersion = Date.now();
  let liveTimer = null;
  const broadcastLive = () => {
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => {
      liveVersion += 1;
      for (const client of liveClients) client.write(`event: feed\nid: ${liveVersion}\ndata: ${liveVersion}\n\n`);
    }, 400);
    liveTimer.unref?.();
  };
  events.on('news.changed', broadcastLive);
  events.on('news.published', broadcastLive);
  const heartbeat = setInterval(() => { for (const client of liveClients) client.write(': ping\n\n'); }, 25_000);
  heartbeat.unref?.();

  const liveClientsByIp = new Map();
  router.get('/api/public/live', (request, response) => {
    if (liveClients.size >= LIVE_CLIENT_LIMIT) return response.status(503).json({ error: 'ظرفیت به‌روزرسانی زنده تکمیل است.' });
    // One address must not be able to hold every live slot.
    const clientKey = request.ip || request.socket.remoteAddress || 'unknown';
    const openFromIp = liveClientsByIp.get(clientKey) ?? 0;
    if (openFromIp >= LIVE_CLIENT_LIMIT_PER_IP) return response.status(429).json({ error: 'تعداد اتصال‌های زندهٔ این نشانی از حد مجاز بیشتر است.' });
    liveClientsByIp.set(clientKey, openFromIp + 1);
    request.socket.setTimeout(0);
    response.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    response.write('retry: 5000\n\n');
    liveClients.add(response);
    request.on('close', () => {
      liveClients.delete(response);
      const remaining = (liveClientsByIp.get(clientKey) ?? 1) - 1;
      if (remaining > 0) liveClientsByIp.set(clientKey, remaining);
      else liveClientsByIp.delete(clientKey);
    });
  });

  router.get('/media/placeholder/:color.svg', (request, response) => {
    const color = request.params.color;
    if (!/^[a-f\d]{6}$/i.test(color)) return response.status(404).end();
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    response.type('image/svg+xml');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    return response.send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 9"><rect width="16" height="9" fill="#${color}"/></svg>`);
  });

  router.get('/api/public/config', async (request, response, next) => {
    try {
      const result = await cache.get('config', async () => {
        const [settings, provinces] = await Promise.all([
          settingsMap(pool, ['site_title', 'radio_enabled', 'radio_title', 'radio_stream_url', 'radio_nowplaying_url']),
          visibleRegions(pool),
        ]);
        let radio = { enabled: false };
        if (settings.radio_enabled === '1') {
          try {
            const streamUrl = new URL(settings.radio_stream_url);
            if (['http:', 'https:'].includes(streamUrl.protocol) && !streamUrl.username && !streamUrl.password && !(config.publicUrl.startsWith('https://') && streamUrl.protocol === 'http:')) {
              radio = { enabled: true, title: settings.radio_title?.trim() || 'رادیو', stream_url: streamUrl.href };
              // lets the player read "now playing" from the browser when this server cannot reach the radio
              try {
                const nowPlayingUrl = resolveNowPlayingUrl({ nowPlayingUrl: settings.radio_nowplaying_url, streamUrl: streamUrl.href });
                if (nowPlayingUrl && ['http:', 'https:'].includes(nowPlayingUrl.protocol) && !nowPlayingUrl.username && !nowPlayingUrl.password &&
                    !(config.publicUrl.startsWith('https://') && nowPlayingUrl.protocol === 'http:')) radio.nowplaying_url = nowPlayingUrl.href;
              } catch {}
            }
          } catch {}
        }
        return { site_title: settings.site_title || 'اخبار پیام نور', radio, provinces };
      });
      response.setHeader('Cache-Control', 'public, max-age=15');
      return response.json(result);
    } catch (error) {
      return next(error);
    }
  });

  // Category chips of the reader: only categories that have news for this reader's center (and the extra regions
  // the reader chose to include), each with its news count; most news first, then alphabetical.
  router.get('/api/public/categories', async (request, response, next) => {
    const cityId = idValue(request.query.city);
    const scope = String(request.query.scope ?? 'all');
    if (!cityId) return response.status(400).json({ error: 'برای دریافت دسته‌بندی‌ها باید یک مرکز دانشگاهی انتخاب کنید.' });
    if (!FEED_SCOPES.has(scope)) return response.status(400).json({ error: 'دامنهٔ نمایش معتبر نیست.' });
    const flags = {};
    for (const [name, fallback] of [['country', '1'], ['province', '1'], ['siblings', '0']]) {
      const value = String(request.query[name] ?? fallback);
      if (value !== '0' && value !== '1') return response.status(400).json({ error: 'گزینهٔ نمایش خبر معتبر نیست.' });
      flags[name] = value === '1';
    }
    try {
      const city = await loadVisibleCity(pool, cityId);
      if (!city) return response.status(400).json({ error: 'مرکز دانشگاهی انتخاب‌شده در دسترس نیست.' });
      const key = `categories:${cityId}:${scope}:${Number(flags.country)}${Number(flags.province)}${Number(flags.siblings)}`;
      const result = await cache.get(key, async () => {
        const regionIds = await feedRegionIds(pool, city, flags);
        return { categories: await visibleCategoryCounts(pool, regionIds, scope) };
      });
      response.setHeader('Cache-Control', 'public, max-age=15');
      return response.json(result);
    } catch (error) {
      return next(error);
    }
  });

  router.get('/api/public/feed', async (request, response, next) => {
    const cityId = idValue(request.query.city);
    const scope = String(request.query.scope ?? 'all');
    const requestedLimit = Number(request.query.limit ?? 12);
    const categoryId = request.query.category == null || request.query.category === '' ? null : idValue(request.query.category);
    if (!cityId) return response.status(400).json({ error: 'برای دریافت خبر باید یک مرکز دانشگاهی انتخاب کنید.' });
    if (request.query.category != null && request.query.category !== '' && !categoryId) return response.status(400).json({ error: 'دسته‌بندی معتبر نیست.' });
    if (!FEED_SCOPES.has(scope)) return response.status(400).json({ error: 'دامنهٔ نمایش معتبر نیست.' });
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 12) {
      return response.status(400).json({ error: 'تعداد خبر در هر صفحه باید بین ۱ تا ۱۲ باشد.' });
    }
    const flags = {};
    for (const [name, fallback] of [['country', '1'], ['province', '1'], ['siblings', '0']]) {
      const value = String(request.query[name] ?? fallback);
      if (value !== '0' && value !== '1') return response.status(400).json({ error: 'گزینهٔ نمایش خبر معتبر نیست.' });
      flags[name] = value === '1';
    }
    const cursor = request.query.cursor ? decodeCursor(request.query.cursor) : null;
    if (request.query.cursor && !cursor) return response.status(400).json({ error: 'نشانگر صفحه معتبر نیست.' });
    try {
      const city = await loadVisibleCity(pool, cityId);
      if (!city) return response.status(400).json({ error: 'مرکز دانشگاهی انتخاب‌شده در دسترس نیست.' });
      const key = `feed:${cityId}:${scope}:${categoryId ?? 0}:${Number(flags.country)}${Number(flags.province)}${Number(flags.siblings)}:${requestedLimit}:${request.query.cursor ?? ''}`;
      const result = await cache.get(key, async () => {
        const regionIds = await feedRegionIds(pool, city, flags);
        const [rows, pinnedRows] = await Promise.all([
          feedRows(pool, city, { scope, cursor, limit: requestedLimit, regionIds, categoryId }),
          cursor ? Promise.resolve([]) : feedRows(pool, city, { scope, cursor: null, limit: 6, regionIds, categoryId, pinned: true }),
        ]);
        const hasMore = rows.length > requestedLimit;
        const items = rows.slice(0, requestedLimit).map(publicItem);
        return {
          items,
          next_cursor: hasMore ? encodeCursor(rows[requestedLimit - 1]) : null,
          ...(cursor ? {} : { pinned: pinnedRows.map(publicItem) }),
        };
      });
      response.setHeader('Cache-Control', 'public, max-age=15');
      return response.json(result);
    } catch (error) {
      return next(error);
    }
  });

  router.get('/api/public/news/:id', async (request, response, next) => {
    const id = idValue(request.params.id);
    if (!id) return response.status(404).json({ error: 'خبر پیدا نشد.' });
    try {
      const [rows] = await pool.execute(
        `SELECT n.id, n.title, n.summary, n.body_html, n.news_type, n.category_id, c.name AS category_name,
                n.published_at, n.expires_at, n.is_pinned, n.is_urgent, n.view_count,
                n.publisher_name, n.publisher_unit, n.source_url, n.source_image_url, n.cover_attachment_id,
                settings.v AS byline_show_person
         FROM news n LEFT JOIN categories c ON c.id = n.category_id
         LEFT JOIN settings ON settings.k = 'byline_show_person'
         WHERE n.id = ? AND n.status = 'published' AND n.published_at <= UTC_TIMESTAMP()
           AND n.deleted_at IS NULL AND (n.expires_at IS NULL OR n.expires_at > UTC_TIMESTAMP())
           AND EXISTS (SELECT 1 FROM news_targets target WHERE target.news_id = n.id)
         LIMIT 1`,
        [id],
      );
      const news = rows[0];
      if (!news) return response.status(404).json({ error: 'خبر پیدا نشد.' });
      const viewKey = createHash('sha256').update(`${id}:${request.ip || request.socket.remoteAddress || 'unknown'}`).digest('hex');
      const now = clock();
      for (const [key, expiresAt] of viewDedupe) if (expiresAt <= now) viewDedupe.delete(key);
      if (!viewDedupe.has(viewKey)) {
        await pool.execute('UPDATE news SET view_count = view_count + 1, updated_at = updated_at WHERE id = ?', [id]);
        viewDedupe.set(viewKey, now + VIEW_DEDUPE_MS);
        while (viewDedupe.size > VIEW_DEDUPE_LIMIT) viewDedupe.delete(viewDedupe.keys().next().value);
        news.view_count = Number(news.view_count) + 1;
      }
      const [attachments] = await pool.execute(
        `SELECT id, kind, original_name, stored_name, mime, size_bytes, width, height, dominant_color
         FROM attachments WHERE news_id = ? ORDER BY id`,
        [id],
      );
      const imageAttachments = attachments.filter((attachment) => attachment.kind !== 'file').map((attachment) => ({
        id: Number(attachment.id), kind: attachment.kind, original_name: attachment.original_name,
        mime: attachment.mime, size_bytes: Number(attachment.size_bytes), width: attachment.width,
        height: attachment.height, dominant_color: attachment.dominant_color, ...imageUrls(attachment.stored_name),
      }));
      const files = attachments.filter((attachment) => attachment.kind === 'file').map((attachment) => ({
        id: Number(attachment.id), kind: 'file', original_name: attachment.original_name,
        mime: attachment.mime, size_bytes: Number(attachment.size_bytes), url: `/files/${attachment.id}`,
      }));
      const coverAttachment = attachments.find((attachment) => Number(attachment.id) === Number(news.cover_attachment_id));
      const coverImage = coverAttachment ? imageUrls(coverAttachment.stored_name) : null;
      const byline = news.byline_show_person === '0' ? { publisher_unit: news.publisher_unit } : {
        publisher_name: news.publisher_name,
        publisher_unit: news.publisher_unit,
      };
      return response.json({
        item: {
          id: Number(news.id), title: news.title, summary: news.summary,
          news_type: news.news_type === 'announcement' ? 'announcement' : 'news',
          body_html: sanitizeBodyHtml(news.body_html, { brand: true }),
          category: news.category_id == null ? null : { id: Number(news.category_id), name: news.category_name },
          published_at: news.published_at.toISOString(), expires_at: news.expires_at?.toISOString() ?? null,
          is_pinned: Boolean(news.is_pinned), is_urgent: Boolean(news.is_urgent),
          view_count: Number(news.view_count), ...byline,
          cover: coverImage ? {
                      ...coverImage,
                      id: Number(coverAttachment.id),
                      width: coverAttachment.width,
                      height: coverAttachment.height,
                      dominant_color: coverAttachment.dominant_color,
                    } : (news.source_image_url ? { src: news.source_image_url, srcset: '', external: true } : defaultCover(news.news_type)),
          images: imageAttachments, files,
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  let radioFailureLoggedAt = 0;
  router.get('/api/public/radio', async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    try {
      const settings = await settingsMap(pool, ['radio_enabled', 'radio_nowplaying_url', 'radio_stream_url']);
      if (settings.radio_enabled !== '1') return response.json({ now_playing: null });
      const url = resolveNowPlayingUrl({ nowPlayingUrl: settings.radio_nowplaying_url, streamUrl: settings.radio_stream_url });
      if (!url) return response.json({ now_playing: null });
      if (radioCache.url === url.href && radioCache.expiresAt > clock()) return response.json(radioCache.value);
      let nowPlaying = null;
      let unreachable = false;
      try {
        nowPlaying = await fetchNowPlaying(url, {
          fetchImpl, publicUrl: config.publicUrl, streamUrl: settings.radio_stream_url || '', resolvesPublic: makeRadioResolver(config.radioTrustedHosts),
        });
      } catch (error) {
        unreachable = ['network', 'internal'].includes(error.code);
        // Not an error for the visitor (the bar just shows the station), but the administrator needs to see why.
        if (clock() - radioFailureLoggedAt > 300_000) {
          radioFailureLoggedAt = clock();
          console.warn(`Radio now-playing could not be read from ${url.origin}${url.pathname}: ${error.message}`);
        }
      }
      // unreachable: this server cannot reach the radio, so the player may try from the visitor's browser instead.
      // That state is remembered longer so every poll does not wait for a new timeout.
      radioCache = { url: url.href, expiresAt: clock() + (nowPlaying ? 15_000 : unreachable ? 60_000 : 5_000), value: unreachable ? { now_playing: null, reachable: false } : { now_playing: nowPlaying } };
      return response.json(radioCache.value);
    } catch {
      return response.json({ now_playing: null });
    }
  });

  router.get('/n/:id', async (request, response, next) => {
    const id = idValue(request.params.id);
    if (!id) return response.status(404).type('text/plain').send('خبر پیدا نشد.');
    try {
      const [rows] = await pool.execute(
        `SELECT n.title, n.summary, n.news_type, n.published_at, cover.stored_name, settings.v AS site_title
         FROM news n
         LEFT JOIN attachments cover ON cover.id = n.cover_attachment_id
         LEFT JOIN settings ON settings.k = 'site_title'
         WHERE n.id = ? AND n.status = 'published' AND n.published_at <= UTC_TIMESTAMP()
           AND n.deleted_at IS NULL AND (n.expires_at IS NULL OR n.expires_at > UTC_TIMESTAMP())
           AND EXISTS (SELECT 1 FROM news_targets target WHERE target.news_id = n.id)
         LIMIT 1`,
        [id],
      );
      const news = rows[0];
      if (!news) return response.status(404).type('text/plain').send('خبر پیدا نشد.');
      const title = normalizeBrandName(plainString(news.title, 240));
      const summary = normalizeBrandName(plainString(news.summary, 600));
      const imagePath = imageUrls(news.stored_name)?.src ?? defaultCover(news.news_type).src;
      const image = imagePath ? new URL(imagePath, config.publicUrl).href : null;
      const siteTitle = normalizeBrandName(plainString(news.site_title || 'اخبار پیام نور', 160));
      const canonical = new URL(`/n/${id}`, config.publicUrl).href;
      const shell = staticAssets?.get('/index.html')?.body.toString('utf8');
      const html = shell ? injectOpenGraph(shell, { title, summary, image, canonical, siteTitle })
        : makeHtmlShell({ title, summary, image, canonical, siteTitle });
      response.setHeader('Cache-Control', 'public, max-age=60');
      return response.type('html').send(html);
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
