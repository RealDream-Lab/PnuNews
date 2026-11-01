// Reads the main-news list straight from the university portal (Douran Portal, pnu.ac.ir) and returns it in the same
// JSON shape that the radio server's proxy.php (action=pnu_news) used to return, so the importer needs no other change.
// This is a port of the pnu_news action of proxy.php: same page, same selectors, same connect-retry behaviour.
import https from 'node:https';
import { DomUtils, parseDocument } from 'htmlparser2';
import { portalUrl } from './portal-parse.js';

export const PORTAL_SOURCE_URL = 'https://pnu.ac.ir/fa-IR/DouranPortal/6021/page/%D8%A7%D8%AE%D8%A8%D8%A7%D8%B1-%D8%A7%D8%B5%D9%84%DB%8C';
export const PORTAL_BASE_URL = 'https://pnu.ac.ir';
export const PORTAL_SCRAPE_LIMIT = 10;
// Cache of the portal list: the result of one fetch is reused for 3 minutes (proxy.php kept it for 10). The importer's own
// timer uses the same period, so news shows up at most about 3 minutes after the portal publishes it.
export const PORTAL_CACHE_TTL_MS = 3 * 60_000;
export const PORTAL_MIN_FORCE_AGE_MS = 30_000; // "fetch now" only skips the cache when the cached list is older than this

const CONNECT_TIMEOUT_MS = 4_000; // per attempt; a lost SYN gets another chance
const CONNECT_TRIES = 3; // only when the connection itself could not be made
const TOTAL_TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 3;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const USER_AGENT = 'Mozilla/5.0 (compatible; PNU-News-Reader/1.0)';

// ---------- Parsing ----------

const collapse = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const idContains = (element, part) => (element.attribs?.id ?? '').includes(part);
const hasClass = (element, name) => (element.attribs?.class ?? '').split(/\s+/).includes(name);

function absolute(value) {
  if (!value) return null;
  try {
    return new URL(value, PORTAL_BASE_URL).href;
  } catch {
    return null;
  }
}

export function parsePortalHtml(html, limit = PORTAL_SCRAPE_LIMIT) {
  const document = parseDocument(String(html ?? ''));
  const panels = DomUtils.findAll((node) => node.name === 'div' && idContains(node, '_NewsContentPanel'), document.children);
  const items = [];
  for (const panel of panels) {
    if (items.length >= limit) break;
    const titleLink = DomUtils.findOne((node) => node.name === 'a' && hasClass(node, 'DPNewsItemTitle'), panel.children);
    if (!titleLink) continue; // incomplete item

    const image = DomUtils.findOne((node) => node.name === 'img' && node.attribs?.alt !== undefined, panel.children);
    const datePanel = DomUtils.findOne((node) => node.name === 'span' && idContains(node, '_DetailsDatePanel'), panel.children);
    let timestampMs = null;
    let date = null;
    let time = null;
    if (datePanel) {
      const unix = Number.parseInt(datePanel.attribs.unix ?? '', 10);
      timestampMs = Number.isFinite(unix) ? unix : null;
      for (const span of DomUtils.findAll((node) => node.name === 'span' && Boolean(node.attribs?.id), datePanel.children)) {
        if (span.attribs.id.endsWith('_DetailsSubmitDate')) date = DomUtils.textContent(span).trim();
        else if (span.attribs.id.endsWith('_DetailsSubmitTime')) time = DomUtils.textContent(span).trim();
      }
    }
    const abstract = DomUtils.findOne(
      (node) => node.name === 'span' && idContains(node, '_NewsAbstract') && !idContains(node, 'MorePanel'),
      panel.children,
    );

    items.push({
      title: collapse(DomUtils.textContent(titleLink)),
      link: absolute(titleLink.attribs.href),
      image: absolute(image?.attribs?.src),
      abstract: abstract ? collapse(DomUtils.textContent(abstract)) : '',
      date,
      time,
      timestamp_ms: timestampMs,
    });
  }
  return items;
}

// ---------- Fetching ----------

function connectError(message) {
  return Object.assign(new Error(message), { connectFailed: true });
}

// One HTTPS GET. `connectFailed` on the error tells the caller the TCP connection was never established
// (worth another try); anything after the connection is made is not retried.
export function requestOnce(target, { connectTimeoutMs = CONNECT_TIMEOUT_MS, totalTimeoutMs = TOTAL_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let connected = false;
    let connectTimer = null;
    let totalTimer = null;
    let request = null;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(totalTimer);
      settle(value);
    };
    const fail = (error) => {
      request?.destroy();
      finish(reject, error);
    };

    request = https.get(target, {
      agent: false,
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'fa-IR,fa;q=0.9',
        'accept-encoding': 'identity',
      },
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { fail(new Error('حجم پاسخ سایت مبدأ بیش از حد مجاز است.')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => finish(resolve, {
        status: response.statusCode ?? 0,
        location: response.headers.location ?? null,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      response.on('error', (error) => fail(new Error(error.message)));
    });
    connectTimer = setTimeout(() => fail(connectError('اتصال به سایت مبدأ برقرار نشد (مهلت اتصال تمام شد).')), connectTimeoutMs);
    totalTimer = setTimeout(() => fail(new Error('مهلت دریافت صفحه از سایت مبدأ تمام شد.')), totalTimeoutMs);
    request.on('socket', (socket) => {
      const onConnect = () => { connected = true; clearTimeout(connectTimer); };
      if (socket.connecting) socket.once('connect', onConnect);
      else onConnect();
    });
    request.on('error', (error) => {
      const code = error.code ? ` (${error.code})` : '';
      fail(connected ? new Error(`${error.message}${code}`) : connectError(`اتصال به سایت مبدأ برقرار نشد${code}.`));
    });
  });
}

async function requestWithConnectRetries(target, request, tries) {
  let lastError = null;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      return await request(target);
    } catch (error) {
      lastError = error;
      if (!error.connectFailed) break;
    }
  }
  throw new Error(`خطا در دریافت صفحه: ${lastError?.message ?? 'نامشخص'}`);
}

export async function fetchPortalHtml({ url = PORTAL_SOURCE_URL, request = requestOnce, tries = CONNECT_TRIES } = {}) {
  let target = url;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await requestWithConnectRetries(target, request, tries);
    if ([301, 302, 303, 307, 308].includes(response.status) && response.location) {
      // Only ever follow redirects that stay on https://*.pnu.ac.ir.
      const next = portalUrl(new URL(response.location, target).href);
      if (!next) throw new Error('سایت مبدأ به نشانی نامعتبری تغییر مسیر داد.');
      target = next;
      continue;
    }
    if (response.status >= 400) throw new Error(`کد HTTP نامعتبر از سایت مبدأ: ${response.status}`);
    return response.body;
  }
  throw new Error('تعداد تغییر مسیرهای سایت مبدأ بیش از حد است.');
}

// Same JSON shape as proxy.php?action=pnu_news.
export async function fetchPortalPayload({ fetchHtml = fetchPortalHtml, now = () => new Date(), limit = PORTAL_SCRAPE_LIMIT } = {}) {
  const items = parsePortalHtml(await fetchHtml(), limit);
  if (!items.length) throw new Error('هیچ خبری پیدا نشد؛ احتمالاً ساختار صفحهٔ مبدأ تغییر کرده.');
  return { source: PORTAL_SOURCE_URL, count: items.length, fetched_at: now().toISOString(), items };
}

// Wraps fetchPortalPayload in an in-memory cache. Calls inside the TTL get the cached payload, concurrent calls share one
// fetch, and a failed fetch is never cached (the error goes to the caller; the previous good payload is kept untouched).
// `force` skips the cache, but only when the cached payload is at least `minForceAgeMs` old.
export function createCachedPortalPayload({
  fetchHtml = fetchPortalHtml,
  ttlMs = PORTAL_CACHE_TTL_MS,
  minForceAgeMs = PORTAL_MIN_FORCE_AGE_MS,
  clock = Date.now,
  limit,
} = {}) {
  let cached = null; // { at, payload }; `at` is when the fetch started
  let inFlight = null;
  // A timer that fires a hair early must not count as "still fresh", otherwise a whole cycle would be skipped.
  const TOLERANCE_MS = 1_000;

  async function get({ force = false } = {}) {
    const age = cached ? clock() - cached.at : Infinity;
    const fresh = age < ttlMs - TOLERANCE_MS;
    if (cached && fresh && !(force && age >= minForceAgeMs)) return cached.payload;
    if (inFlight) return inFlight;
    const startedAt = clock();
    inFlight = (async () => {
      try {
        const payload = await fetchPortalPayload({ fetchHtml, now: () => new Date(clock()), limit });
        cached = { at: startedAt, payload };
        return payload;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }
  get.clear = () => { cached = null; };
  return get;
}
