import { initDock } from '/shared/dock.v0.1.43.js';
import { itemSignature, planLiveUpdate, pinnedSignature } from '/shared/live-plan.v0.1.43.js';

const app = document.getElementById('app');
const newsView = document.getElementById('news-view');
const feed = document.getElementById('feed');
const picker = document.getElementById('city-picker');
const pickerList = document.getElementById('picker-list');
const pickerSearch = document.getElementById('picker-search');
const pickerBack = document.getElementById('picker-back');
const feedMessage = document.getElementById('feed-message');
const searchField = document.querySelector('.search-field');
const sentinel = document.getElementById('feed-sentinel');
const pinnedStrip = document.getElementById('pinned-strip');
const newItemsBanner = document.getElementById('new-items-banner');
const installRoot = document.getElementById('install-root');
const updateRoot = document.getElementById('update-root');

const state = {
  config: null,
  city: null,
  province: null,
  pickerProvince: null,
  scope: 'all', // always "all" for now; will become a setting later
  cursor: null,
  loading: false,
  ended: false,
  entries: [],
  spacer: null,
  spacerHeight: 0,
  pinnedIds: new Set(),
  pinnedSig: '',
  firstId: null,
  newsId: null,
  refreshTimer: null,
  toastTimer: null,
  fontScale: 1,
};
let intersectionObserver = null;

const digits = new Intl.NumberFormat('fa-IR');

const dateFormatter = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  timeZone: 'Asia/Tehran', day: 'numeric', month: 'long', year: 'numeric',
});
const timeFormatter = new Intl.DateTimeFormat('fa-IR', {
  timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function normalizeSearch(value) {
  return String(value ?? '').toLowerCase()
    .replace(/[\u064b-\u065f\u0670]/g, '')
    .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک')
    .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x6f0))
    .replace(/ـ/g, '').replace(/[\u200c\u200e\u200f]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function searchKey(value) {
  return normalizeSearch(value).replace(/ /g, '');
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('is-visible');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2600);
}

const dock = initDock({ showToast });

// ---------- Reader preferences (stored on this device only) ----------
const PREFS_KEY = 'pnu.prefs';
const DEFAULT_PREFS = Object.freeze({ radio: true, country: true, province: true, siblings: false });
const prefs = { ...DEFAULT_PREFS };
try {
  const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
  if (saved && typeof saved === 'object') {
    for (const key of Object.keys(DEFAULT_PREFS)) if (typeof saved[key] === 'boolean') prefs[key] = saved[key];
  }
} catch {}

function applyRadioPreference() {
  document.documentElement.classList.toggle('radio-hidden', !prefs.radio);
  if (!prefs.radio) dock.stopRadio();
}
applyRadioPreference();

// Query string part of the feed request that depends on the reader's choices.
function feedPreferenceParams() {
  return { country: prefs.country ? '1' : '0', province: prefs.province ? '1' : '0', siblings: prefs.siblings ? '1' : '0' };
}

// The install / update cards float just above the footer, whatever its height is (the radio makes it taller on phones).
const siteDock = document.querySelector('.site-dock');
if (siteDock && 'ResizeObserver' in window) {
  new ResizeObserver(() => document.documentElement.style.setProperty('--dock-height', `${siteDock.offsetHeight}px`)).observe(siteDock);
}

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  let body;
  try { body = await response.json(); } catch { body = {}; }
  if (!response.ok) throw new Error(body.error || 'دریافت اطلاعات ناموفق بود.');
  return body;
}

function findCity(id) {
  const wanted = Number(id);
  for (const province of state.config?.provinces ?? []) {
    const city = province.cities.find((item) => Number(item.id) === wanted);
    if (city) return { city, province };
  }
  return null;
}

function updateSelectedCity() {
  const label = document.getElementById('selected-city-label');
  const description = document.getElementById('feed-description');
  if (!state.city || !state.province) {
    label.textContent = 'انتخاب مرکز دانشگاهی';
    description.textContent = 'برای دیدن خبرهای مرتبط، مرکز دانشگاهی خود را انتخاب کنید.';
    description.hidden = false;
    return;
  }
  label.textContent = state.city.name;
  description.textContent = '';
  description.hidden = true;
}

function setCity(city, province) {
  state.city = city;
  state.province = province;
  try { localStorage.setItem('pnu.city', String(city.id)); } catch {}
  updateSelectedCity();
  picker.close();
  newItemsBanner.hidden = true;
  resetFeed();
}

function pickerNotice(title, detail = '') {
  return `<div class="picker-notice"><strong>${escapeHtml(title)}</strong>${detail ? `<span>${escapeHtml(detail)}</span>` : ''}</div>`;
}

function cityOption(city, caption = '') {
  const selected = state.city && Number(state.city.id) === Number(city.id);
  return `<button class="picker-option${selected ? ' is-selected' : ''}" type="button" data-city-id="${city.id}"><span class="picker-name">${escapeHtml(city.name)}</span>${caption ? `<span class="picker-meta">${escapeHtml(caption)}</span>` : ''}${selected ? '<svg class="icon"><use href="#icon-check"/></svg>' : ''}</button>`;
}

function renderPickerList() {
  const province = state.pickerProvince;
  const query = searchKey(pickerSearch.value);
  pickerBack.hidden = !province;
  document.getElementById('picker-step').textContent = province ? 'مرحلهٔ ۲ از ۲' : 'مرحلهٔ ۱ از ۲';
  document.getElementById('picker-title').textContent = province ? `مراکز دانشگاهی ${province.name}` : 'استان خود را انتخاب کنید';
  pickerSearch.placeholder = province ? 'جست‌وجوی مرکز دانشگاهی' : 'جست‌وجوی استان یا مرکز دانشگاهی';
  if (!state.config) {
    searchField.hidden = true;
    pickerList.innerHTML = pickerNotice('در حال دریافت فهرست مناطق…');
    return;
  }
  if (province && !province.cities.length) {
    searchField.hidden = true;
    pickerList.innerHTML = pickerNotice('فعلاً برای استان شما فعال نشده است.', 'پس از فعال شدن، مرکز دانشگاهی خود را از همین‌جا انتخاب کنید.');
    return;
  }
  searchField.hidden = false;
  if (province) {
    const cities = province.cities.filter((city) => !query || searchKey(city.name).includes(query));
    pickerList.innerHTML = cities.length ? cities.map((city) => cityOption(city)).join('') : pickerNotice('مرکز دانشگاهی با این نام پیدا نشد.');
    return;
  }
  const provinces = state.config.provinces.filter((item) => !query || searchKey(item.name).includes(query));
  const provinceItems = provinces.map((item) => {
    const count = item.cities.length;
    const meta = count ? `${digits.format(count)} مرکز دانشگاهی` : 'فعال نشده';
    return `<button class="picker-option${count ? '' : ' is-inactive'}" type="button" data-province-id="${item.id}"><span class="picker-name">${escapeHtml(item.name)}</span><span class="picker-meta">${meta}</span><svg class="icon"><use href="#icon-chevron"/></svg></button>`;
  });
  const cityItems = query
    ? state.config.provinces.flatMap((item) => item.cities.filter((city) => searchKey(city.name).includes(query)).map((city) => cityOption(city, item.name)))
    : [];
  const parts = [];
  if (provinceItems.length) parts.push(...(cityItems.length ? ['<p class="picker-group-title">استان‌ها</p>'] : []), ...provinceItems);
  if (cityItems.length) parts.push('<p class="picker-group-title">مراکز دانشگاهی</p>', ...cityItems);
  pickerList.innerHTML = parts.length ? parts.join('') : pickerNotice('موردی پیدا نشد.');
}

function focusPickerSearch() {
  if (!searchField.hidden && matchMedia('(pointer: fine)').matches) pickerSearch.focus();
}

function openPicker() {
  if (!state.config) {
    showToast('در حال دریافت فهرست مناطق…');
    return;
  }
  const selected = state.city ? findCity(state.city.id) : null;
  state.pickerProvince = selected?.province ?? null;
  pickerSearch.value = '';
  renderPickerList();
  if (!picker.open) picker.showModal();
  pickerList.scrollTop = 0;
  focusPickerSearch();
}

// Label shown on a news item: nothing for the reader's own city, central organization for national news,
// and the university's provincial branch for province-level news.
function scopeName(item) {
  if (item.scope.type === 'country') return 'سازمان مرکزی';
  if (item.scope.type === 'province') return `دانشگاه پیام‌نور استان ${item.scope.name}`;
  // News of another center of the same province (shown only when the reader asked for them).
  if (item.scope.type === 'city' && state.city && Number(item.scope.id) !== Number(state.city.id)) return `دانشگاه پیام‌نور ${item.scope.name}`;
  return '';
}

function relativeDate(isoDate) {
  const date = new Date(isoDate);
  const delta = Math.max(0, Date.now() - date.getTime());
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return 'لحظاتی پیش';
  if (delta < hour) return `${digits.format(Math.floor(delta / minute))} دقیقه پیش`;
  if (delta < day) return `${digits.format(Math.floor(delta / hour))} ساعت پیش`;
  if (delta < 2 * day) return 'دیروز';
  if (delta < 7 * day) return `${digits.format(Math.floor(delta / day))} روز پیش`;
  return `${dateFormatter.format(date)} — ${timeFormatter.format(date)}`;
}

function safeColorCode(value) {
  return /^#[a-f\d]{6}$/i.test(value ?? '') ? value.slice(1) : 'eef3fa';
}

function placeholderMarkup(color, className = 'cover-placeholder') {
  return `<img class="${className}" src="/media/placeholder/${safeColorCode(color)}.svg" width="16" height="9" alt="" aria-hidden="true">`;
}

const CARD_IMAGE_SIZES = '(max-width: 639px) 100vw, (max-width: 959px) 50vw, 33vw';
const FEATURED_IMAGE_SIZES = '(max-width: 959px) 100vw, 650px';

function coverMarkup(item, featured, overlay = '') {
  const placeholder = placeholderMarkup(item.cover.dominant_color);
  return `<div class="card-cover-frame">${placeholder}<img class="card-cover" referrerpolicy="no-referrer" src="${escapeHtml(item.cover.src)}" srcset="${escapeHtml(item.cover.srcset ?? '')}" sizes="${featured ? FEATURED_IMAGE_SIZES : CARD_IMAGE_SIZES}" width="${Number(item.cover.width) || 800}" height="${Number(item.cover.height) || 450}" loading="lazy" decoding="async" alt="">${overlay}</div>`;
}

// Cards of portal news open the original article on pnu.ac.ir instead of our detail page.
function externalAttributes(item) {
  return typeof item.source_url === 'string' && item.source_url.startsWith('https://')
    ? ` data-source-url="${escapeHtml(item.source_url)}" data-external="true"` : '';
}

function openCard(card) {
  const address = card.dataset.sourceUrl;
  if (address && address.startsWith('https://')) {
    window.open(address, '_blank', 'noopener,noreferrer');
    return;
  }
  navigateToNews(card.dataset.newsId);
}

function pinnedMarkup(item) {
  const thumbnail = item.cover?.src
    ? `<div class="pinned-cover-frame">${placeholderMarkup(item.cover.dominant_color)}<img referrerpolicy="no-referrer" src="${escapeHtml(item.cover.src)}" width="104" height="59" loading="lazy" alt=""></div>`
    : '';
  const classes = ['pinned-card', item.is_urgent ? 'is-urgent' : '', thumbnail ? '' : 'no-thumb'].filter(Boolean).join(' ');
  return `<article class="${classes}" data-news-id="${item.id}"${externalAttributes(item)} tabindex="0" role="link" aria-label="${escapeHtml(item.title)}">${thumbnail}<div><div class="card-meta"><span class="card-kicker">${item.is_urgent ? 'خبر فوری' : 'خبر مهم'}</span></div><h2>${escapeHtml(item.title)}</h2></div></article>`;
}

const PORTAL_LABEL = 'خبرهای پورتال سازمان مرکزی';

function cardMarkup(item, { featured = false } = {}) {
  const hasCover = Boolean(item.cover?.src);
  // Automatic portal news: one meta line only (where it comes from + when it was published).
  if (typeof item.source_url === 'string' && item.source_url.startsWith('https://')) {
    const time = `<time datetime="${escapeHtml(item.published_at)}">${relativeDate(item.published_at)}</time>`;
    const line = `<span class="card-kicker portal-kicker">${PORTAL_LABEL}</span><i aria-hidden="true"></i>${time}`;
    const portalClasses = ['news-card', hasCover ? '' : 'no-cover', featured ? 'is-featured' : ''].filter(Boolean).join(' ');
    const portalSummary = item.summary ? `<p class="card-summary">${escapeHtml(item.summary)}</p>` : '';
    const portalBody = hasCover
      ? `<div class="card-content"><h2>${escapeHtml(item.title)}</h2>${portalSummary}</div>`
      : `<div class="card-content"><h2>${escapeHtml(item.title)}</h2>${portalSummary}<div class="card-foot">${line}</div></div>`;
    return `<article class="${portalClasses}" data-news-id="${item.id}"${externalAttributes(item)} data-scope="${escapeHtml(item.scope.type)}" tabindex="0" role="link" aria-label="${escapeHtml(item.title)}">
    ${hasCover ? coverMarkup(item, featured, `<div class="card-meta-overlay"><div class="overlay-row">${line}</div></div>`) : ''}
    ${portalBody}
  </article>`;
  }
  const label = scopeName(item);
  const badge = label ? `<span class="scope-badge" data-scope="${escapeHtml(item.scope.type)}">${escapeHtml(label)}</span>` : '';
  const category = item.category?.name ? `<span class="card-kicker">${escapeHtml(item.category.name)}</span>` : '';
  const urgent = item.is_urgent ? '<span class="urgent-label">فوری</span>' : '';
  const source = item.publisher_unit ? `<span class="card-source">${escapeHtml(item.publisher_unit)}</span><i aria-hidden="true"></i>` : '';
  const time = `<time datetime="${escapeHtml(item.published_at)}">${relativeDate(item.published_at)}</time>`;
  const summary = item.summary ? `<p class="card-summary">${escapeHtml(item.summary)}</p>` : '';
  const classes = ['news-card', item.is_urgent ? 'is-urgent' : '', hasCover ? '' : 'no-cover', featured ? 'is-featured' : ''].filter(Boolean).join(' ');
  // With a cover, all meta sits on a translucent black strip over the image; only title and summary stay below it.
  // Always at most two lines: related labels share the first line, source and time share the second.
  const labels = badge || category || urgent ? `<div class="overlay-row">${badge}${category}${urgent}</div>` : '';
  const overlay = `<div class="card-meta-overlay">${labels}<div class="overlay-row">${source}${time}</div></div>`;
  const body = hasCover
    ? `<div class="card-content"><h2>${escapeHtml(item.title)}</h2>${summary}</div>`
    : `<div class="card-content">${badge || category || urgent ? `<div class="card-meta">${badge}${category}${urgent}</div>` : ''}<h2>${escapeHtml(item.title)}</h2>${summary}<div class="card-foot">${source}${time}</div></div>`;
  return `<article class="${classes}" data-news-id="${item.id}"${externalAttributes(item)} data-scope="${escapeHtml(item.scope.type)}" tabindex="0" role="link" aria-label="${escapeHtml(item.title)}">
    ${hasCover ? coverMarkup(item, featured, overlay) : ''}
    ${body}
  </article>`;
}

// Desktop masonry: the feed is a grid of 8px rows and every card spans as many rows as its own height needs,
// so cards of different heights pack tightly without leaving gaps. Mobile/tablet keep the plain grid.
const MASONRY_ROW = 8;
const masonryQuery = matchMedia('(min-width: 960px)');

function layoutMasonry() {
  const active = masonryQuery.matches;
  feed.classList.toggle('is-masonry', active);
  const nodes = [...feed.children];
  if (!active) {
    for (const node of nodes) node.style.gridRowEnd = '';
    return;
  }
  const gap = Number.parseFloat(getComputedStyle(feed).columnGap) || 16;
  const heights = nodes.map((node) => (node.classList.contains('feed-spacer')
    ? Number.parseFloat(node.style.height) || 0
    : node.getBoundingClientRect().height));
  nodes.forEach((node, index) => {
    const extra = node.classList.contains('feed-spacer') ? 0 : gap;
    node.style.gridRowEnd = `span ${Math.max(1, Math.ceil((heights[index] + extra) / MASONRY_ROW))}`;
  });
}

let masonryFrame = 0;
function scheduleMasonry() {
  cancelAnimationFrame(masonryFrame);
  masonryFrame = requestAnimationFrame(layoutMasonry);
}
masonryQuery.addEventListener('change', layoutMasonry);
window.addEventListener('resize', scheduleMasonry, { passive: true });
document.fonts?.ready.then(layoutMasonry);

// Any change of a card's height (font-size buttons, wrapping, images) re-packs the grid, so cards never overlap.
const masonryObserver = 'ResizeObserver' in window ? new ResizeObserver(scheduleMasonry) : null;

// Cover frames show a shimmer until their image has loaded (or failed).
function settleCover(image) {
  image.closest('.card-cover-frame, .pinned-cover-frame')?.classList.add(image.complete && !image.naturalWidth ? 'is-failed' : 'is-loaded');
}
document.addEventListener('load', (event) => { if (event.target.matches?.('img.card-cover, .pinned-cover-frame img')) settleCover(event.target); }, true);
document.addEventListener('error', (event) => {
  if (event.target.matches?.('img.card-cover, .pinned-cover-frame img')) event.target.closest('.card-cover-frame, .pinned-cover-frame')?.classList.add('is-failed');
}, true);

function watchFeedNode(node) {
  if (node.nodeType !== 1) return;
  if (!node.classList.contains('feed-spacer') && !node.classList.contains('news-skeleton')) masonryObserver?.observe(node);
  node.querySelectorAll?.('img.card-cover').forEach((image) => { if (image.complete && image.naturalWidth) settleCover(image); });
}
new MutationObserver((records) => {
  for (const record of records) {
    record.addedNodes.forEach(watchFeedNode);
    record.removedNodes.forEach((node) => { if (node.nodeType === 1) masonryObserver?.unobserve(node); });
  }
}).observe(feed, { childList: true });
new MutationObserver((records) => {
  for (const record of records) record.addedNodes.forEach((node) => node.nodeType === 1 && node.querySelectorAll?.('img').forEach((image) => { if (image.complete && image.naturalWidth) settleCover(image); }));
}).observe(pinnedStrip, { childList: true });

// Placeholder cards shaped like real ones (cover, kicker, title lines, footer) that pulse until the data arrives.
function skeletonCount(first) {
  const perRow = masonryQuery.matches ? 3 : matchMedia('(min-width: 640px)').matches ? 2 : 1;
  return first ? Math.max(3, perRow * 2) : perRow;
}

function showSkeletons(count = 4) {
  for (let index = 0; index < count; index += 1) {
    const skeleton = document.createElement('div');
    skeleton.className = 'news-skeleton';
    skeleton.setAttribute('aria-hidden', 'true');
    skeleton.innerHTML = '<div class="sk-cover"></div><div class="sk-body"><span class="sk-line sk-short"></span><span class="sk-line"></span><span class="sk-line sk-mid"></span><span class="sk-line sk-tiny"></span></div>';
    feed.append(skeleton);
  }
  layoutMasonry();
}

function clearFeed() {
  intersectionObserver?.unobserve(sentinel);
  feed.replaceChildren();
  state.entries = [];
  state.spacer = null;
  state.spacerHeight = 0;
  state.pinnedIds = new Set();
  state.pinnedSig = '';
  state.cursor = null;
  state.ended = false;
  state.firstId = null;
  liveDirty = false;
  pinnedStrip.replaceChildren();
  pinnedStrip.hidden = true;
  newItemsBanner.hidden = true;
}

function resetFeed({ scroll = false } = {}) {
  clearFeed();
  if (!state.city) {
    feedMessage.textContent = '';
    feed.innerHTML = '<div class="empty-state"><p>برای دیدن خبرها، ابتدا مرکز دانشگاهی خود را انتخاب کنید.</p><button type="button" class="button-primary" data-open-picker>انتخاب مرکز دانشگاهی</button></div>';
    return;
  }
  feedMessage.textContent = '';
  if (scroll) {
    const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    document.getElementById('feed-heading').scrollIntoView({ block: 'start', behavior });
  }
  loadMore();
}

function recycleFeed() {
  const excess = state.entries.length - 60;
  if (excess <= 0) return;
  const removed = state.entries.splice(0, excess);
  const before = feed.getBoundingClientRect().height;
  for (const entry of removed) entry.node.remove();
  if (!state.spacer) {
    state.spacer = document.createElement('div');
    state.spacer.className = 'feed-spacer';
    state.spacer.setAttribute('aria-hidden', 'true');
    feed.prepend(state.spacer);
  }
  state.spacer.style.height = `${state.spacerHeight}px`;
  state.spacerHeight += before - feed.getBoundingClientRect().height;
  state.spacer.style.height = `${Math.max(0, state.spacerHeight)}px`;
  layoutMasonry();
}

async function loadMore() {
  if (!state.city || state.loading || state.ended) return;
  state.loading = true;
  feed.setAttribute('aria-busy', 'true');
  showSkeletons(skeletonCount(!state.cursor));
  const params = new URLSearchParams({ city: state.city.id, scope: state.scope, limit: '12', ...feedPreferenceParams() });
  if (state.cursor) params.set('cursor', state.cursor);
  try {
    const data = await getJson(`/api/public/feed?${params}`);
    feed.querySelectorAll('.news-skeleton').forEach((node) => node.remove());
    const isFirstPage = !state.cursor;
    if (isFirstPage) {
      const pinned = Array.isArray(data.pinned) ? data.pinned : [];
      state.pinnedIds = new Set(pinned.map((item) => Number(item.id)));
      state.pinnedSig = pinnedSignature(pinned);
      pinnedStrip.hidden = !pinned.length;
      if (pinned.length) pinnedStrip.innerHTML = pinned.map(pinnedMarkup).join('');
    }
    for (const item of data.items) {
      if (state.firstId == null) state.firstId = item.id;
      if (state.pinnedIds.has(Number(item.id))) continue;
      const template = document.createElement('template');
      template.innerHTML = cardMarkup(item, { featured: isFirstPage && state.entries.length === 0 && Boolean(item.cover?.src) });
      const node = template.content.firstElementChild;
      feed.append(node);
      state.entries.push({ id: item.id, node, item, sig: itemSignature(item) });
    }
    state.cursor = data.next_cursor;
    state.ended = !data.next_cursor;
    state.loading = false;
    feed.setAttribute('aria-busy', 'false');
    if (state.entries.length || !pinnedStrip.hidden) {
      feedMessage.textContent = state.ended ? 'همین بود؛ خبر تازه‌ای برای نمایش نیست.' : '';
    } else {
      feed.innerHTML = '<div class="empty-state">در این محدوده هنوز خبری منتشر نشده است.</div>';
      feedMessage.textContent = '';
    }
    layoutMasonry();
    recycleFeed();
    if (state.ended) intersectionObserver?.unobserve(sentinel);
    else intersectionObserver?.observe(sentinel);
  } catch (error) {
    feed.querySelectorAll('.news-skeleton').forEach((node) => node.remove());
    state.loading = false;
    feed.setAttribute('aria-busy', 'false');
    feedMessage.textContent = error.message || 'بارگذاری خبرها ناموفق بود.';
  }
}

// ---------- Live updates ----------
// The server pushes a tiny "feed changed" event (SSE); we then refetch the first page and animate the difference
// in: new cards slide in at the top, the rest of the grid glides to its new place (FLIP), edited cards crossfade
// and removed ones fade out. A 60-second poll covers browsers or proxies where the live channel is unavailable.
const LIVE_NEAR_TOP = 360;
const LIVE_EASING = 'cubic-bezier(.22,.8,.26,1)';
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let liveSyncing = false;
let liveDirty = false;
let liveTimer = 0;
let liveHadError = false;

function createCardNode(item, featured) {
  const template = document.createElement('template');
  template.innerHTML = cardMarkup(item, { featured });
  return template.content.firstElementChild;
}

// Rects of the cards that are on (or near) the screen, so only those need to be animated.
function captureRects() {
  const rects = new Map();
  for (const element of [...state.entries.map((entry) => entry.node), pinnedStrip]) {
    const rect = element.getBoundingClientRect();
    if (rect.bottom > -300 && rect.top < innerHeight + 300) rects.set(element, rect);
  }
  return rects;
}

function playFlip(before, skip) {
  if (reducedMotion.matches) return;
  for (const [element, from] of before) {
    if (skip.has(element) || !element.isConnected) continue;
    const to = element.getBoundingClientRect();
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    element.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 520, easing: LIVE_EASING });
  }
}

function animateIn(node) {
  node.classList.add('is-fresh');
  setTimeout(() => node.classList.remove('is-fresh'), 2600);
  if (reducedMotion.matches) return;
  node.animate(
    [{ opacity: 0, transform: 'translateY(-22px) scale(.96)' }, { opacity: 1, transform: 'none' }],
    { duration: 650, delay: 140, easing: LIVE_EASING, fill: 'backwards' },
  );
}

function animateOut(node) {
  if (reducedMotion.matches) return Promise.resolve();
  return node.animate(
    [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.94)' }],
    { duration: 260, easing: 'ease-in', fill: 'forwards' },
  ).finished.catch(() => {});
}

function renderPinnedStrip(pinned) {
  pinnedStrip.hidden = !pinned.length;
  pinnedStrip.innerHTML = pinned.length ? pinned.map(pinnedMarkup).join('') : '';
  if (pinned.length && !reducedMotion.matches) pinnedStrip.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 450, easing: 'ease-out' });
}

async function applyLiveData(data) {
  const plan = planLiveUpdate(state.entries, data);
  const nextPinnedSig = pinnedSignature(plan.pinned);
  const pinnedChanged = nextPinnedSig !== state.pinnedSig;
  const firstId = plan.items[0]?.id ?? null;

  if (!state.entries.length) {
    // Empty state (or nothing loaded yet): simply load the feed normally when something showed up.
    if (plan.items.length || plan.pinned.length) resetFeed();
    return;
  }
  // Cards above the viewport were recycled (a spacer stands in for them): rebuilding from the top is the safe way.
  if (plan.resync || (state.spacer && (plan.inserts.length || plan.removed.length))) { resetFeed(); return; }
  if (!plan.inserts.length && !plan.updates.length && !plan.removed.length && !pinnedChanged) {
    state.firstId = firstId ?? state.firstId;
    return;
  }

  // 1) Cards that disappeared fade out first.
  const removedNodes = state.entries.filter((entry) => plan.removed.includes(Number(entry.id))).map((entry) => entry.node);
  if (removedNodes.length) await Promise.all(removedNodes.map(animateOut));
  if (!state.city || state.newsId || state.loading) { liveDirty = true; return; }

  // 2) Change the DOM in one go, then let the grid glide to its new layout.
  const before = captureRects();
  const fresh = new Set();
  const skip = new Set();
  for (const node of removedNodes) { node.remove(); skip.add(node); }
  state.entries = state.entries.filter((entry) => !plan.removed.includes(Number(entry.id)));

  for (const item of plan.updates) {
    const entry = state.entries.find((candidate) => Number(candidate.id) === Number(item.id));
    if (!entry) continue;
    const node = createCardNode(item, entry.node.classList.contains('is-featured'));
    entry.node.replaceWith(node);
    if (before.has(entry.node)) before.set(node, before.get(entry.node));
    entry.node = node;
    entry.item = item;
    entry.sig = itemSignature(item);
    skip.add(node);
    if (!reducedMotion.matches) node.animate([{ opacity: 0.25 }, { opacity: 1 }], { duration: 500, easing: 'ease-out' });
  }

  for (const { item, afterId } of plan.inserts) {
    const node = createCardNode(item, false);
    const anchorIndex = afterId == null ? -1 : state.entries.findIndex((entry) => Number(entry.id) === Number(afterId));
    if (anchorIndex >= 0) state.entries[anchorIndex].node.after(node);
    else if (state.entries[0]) state.entries[0].node.before(node);
    else feed.prepend(node);
    state.entries.splice(anchorIndex + 1, 0, { id: item.id, node, item, sig: itemSignature(item) });
    fresh.add(node);
    skip.add(node);
  }

  // The first card with a cover is shown big ("featured"); keep that true after inserts/removals.
  state.entries.forEach((entry, index) => {
    const wanted = index === 0 && Boolean(entry.item.cover?.src);
    if (entry.node.classList.contains('is-featured') === wanted) return;
    const node = createCardNode(entry.item, wanted);
    entry.node.replaceWith(node);
    if (before.has(entry.node)) before.set(node, before.get(entry.node));
    if (fresh.has(entry.node)) { fresh.delete(entry.node); fresh.add(node); }
    skip.delete(entry.node);
    skip.add(node);
    entry.node = node;
  });

  if (pinnedChanged) {
    renderPinnedStrip(plan.pinned);
    state.pinnedSig = nextPinnedSig;
  }
  state.pinnedIds = plan.pinnedIds;
  state.firstId = firstId ?? state.firstId;
  newItemsBanner.hidden = true;
  if (!state.entries.length && pinnedStrip.hidden) {
    feed.innerHTML = '<div class="empty-state">در این محدوده هنوز خبری منتشر نشده است.</div>';
  }
  layoutMasonry();
  playFlip(before, skip);
  for (const node of fresh) animateIn(node);
}

async function syncFeed() {
  if (!state.city || state.newsId || state.loading || liveSyncing || document.hidden) { liveDirty = true; return; }
  const cityId = String(state.city.id);
  liveSyncing = true;
  liveDirty = false;
  try {
    const params = new URLSearchParams({ city: cityId, scope: state.scope, limit: '12', ...feedPreferenceParams(), live: String(Date.now()) });
    const data = await getJson(`/api/public/feed?${params}`);
    if (!state.city || String(state.city.id) !== cityId || state.newsId || state.loading) { liveDirty = true; return; }
    if (window.scrollY > LIVE_NEAR_TOP) {
      // The reader is down the page: never move the content under their finger; just offer the banner.
      const plan = planLiveUpdate(state.entries, data);
      if (state.entries.length && (plan.inserts.length || plan.resync)) newItemsBanner.hidden = false;
      liveDirty = true;
      return;
    }
    await applyLiveData(data);
  } catch {
    // Offline or a transient error: the next event or the poll tries again.
  } finally {
    liveSyncing = false;
  }
}

function startLive() {
  if (!('EventSource' in window)) return;
  const source = new EventSource('/api/public/live');
  source.addEventListener('feed', () => {
    clearTimeout(liveTimer);
    // Jitter so thousands of open readers do not hit the server in the same instant.
    liveTimer = setTimeout(syncFeed, 150 + Math.random() * 1800);
  });
  source.addEventListener('error', () => { liveHadError = true; });
  source.addEventListener('open', () => {
    if (liveHadError) { liveHadError = false; syncFeed(); }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && liveDirty) syncFeed(); });
  let scrollFrame = 0;
  window.addEventListener('scroll', () => {
    if (!liveDirty || scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      if (window.scrollY <= 200 && liveDirty) syncFeed();
    });
  }, { passive: true });
}

function applyFontScale() {
  document.documentElement.classList.remove('font-scale-90', 'font-scale-95', 'font-scale-105', 'font-scale-110');
  if (state.fontScale !== 1) document.documentElement.classList.add(`font-scale-${Math.round(state.fontScale * 100)}`);
}

function initFontScale() {
  try {
    const scale = Number(localStorage.getItem('pnu.fontScale'));
    if (scale >= .9 && scale <= 1.1) state.fontScale = scale;
  } catch {}
  applyFontScale();
  document.querySelector('.font-down').addEventListener('click', () => changeFontScale(-.05));
  document.querySelector('.font-up').addEventListener('click', () => changeFontScale(.05));
}

function changeFontScale(delta) {
  state.fontScale = Math.min(1.1, Math.max(.9, Math.round((state.fontScale + delta) * 100) / 100));
  try { localStorage.setItem('pnu.fontScale', String(state.fontScale)); } catch {}
  applyFontScale();
  scheduleMasonry();
}

function initTheme() {
  const button = document.querySelector('.theme-toggle');
  const showTheme = () => {
    const dark = document.documentElement.dataset.theme === 'dark';
    button.querySelector('use').setAttribute('href', dark ? '#icon-sun' : '#icon-moon');
    button.setAttribute('aria-label', dark ? 'تغییر به حالت روشن' : 'تغییر به حالت تیره');
  };
  showTheme();
  button.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('pnu.theme', next); } catch {}
    showTheme();
  });
}

async function refreshConfig() {
  try {
    const nextConfig = await getJson('/api/public/config');
    const regionsChanged = JSON.stringify(nextConfig.provinces) !== JSON.stringify(state.config?.provinces);
    state.config = nextConfig;
    const currentNewsTitle = state.newsId ? document.querySelector('#news-view h1')?.textContent : null;
    document.title = currentNewsTitle ? `${currentNewsTitle} — ${nextConfig.site_title || 'اخبار پیام‌نور'}` : nextConfig.site_title || 'اخبار پیام‌نور';
    document.getElementById('site-title').textContent = nextConfig.site_title || 'اخبار پیام‌نور';
    const selected = state.city ? findCity(state.city.id) : null;
    if (state.city && !selected) {
      state.city = null;
      state.province = null;
      try { localStorage.removeItem('pnu.city'); } catch {}
      updateSelectedCity();
      resetFeed();
      feedMessage.textContent = 'مرکز دانشگاهی قبلی دیگر در دسترس نیست؛ لطفاً مرکز دانشگاهی دیگری انتخاب کنید.';
      openPicker();
    } else if (selected) {
      state.city = selected.city;
      state.province = selected.province;
      updateSelectedCity();
    }
    dock.renderRadio(nextConfig.radio);
    if (state.city && feed.childElementCount === 0 && !state.loading) resetFeed();
    if (regionsChanged) {
      if (state.pickerProvince) state.pickerProvince = nextConfig.provinces.find((item) => Number(item.id) === Number(state.pickerProvince.id)) ?? null;
      if (picker.open) renderPickerList();
    }
  } catch (error) {
    if (!state.config) feedMessage.textContent = 'ارتباط با سرور برقرار نشد. پس از اتصال دوباره تلاش کنید.';
  }
}

async function initializeReader({ newsOnly = false } = {}) {
  initTheme();
  initFontScale();
  intersectionObserver = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) loadMore();
  }, { rootMargin: '700px 0px' });
  intersectionObserver.observe(sentinel);
  try {
    const config = await getJson('/api/public/config');
    state.config = config;
    document.title = config.site_title || 'اخبار پیام‌نور';
    document.getElementById('site-title').textContent = config.site_title || 'اخبار پیام‌نور';
    if (newsOnly) {
      app.hidden = true;
      newsView.hidden = false;
    } else {
      const savedCityId = (() => {
        try { return localStorage.getItem('pnu.city'); } catch { return null; }
      })();
      const selected = savedCityId ? findCity(savedCityId) : null;
      if (selected) {
        state.city = selected.city;
        state.province = selected.province;
        updateSelectedCity();
        resetFeed();
      } else {
        if (savedCityId) {
          try { localStorage.removeItem('pnu.city'); } catch {}
        }
        updateSelectedCity();
        resetFeed();
        openPicker();
      }
    }
    dock.renderRadio(config.radio);
  } catch {
    feedMessage.textContent = 'ارتباط با سرور برقرار نشد. صفحه را دوباره بارگذاری کنید.';
  }
  state.refreshTimer = setInterval(refreshConfig, 15_000);
  setInterval(syncFeed, 60_000);
  if (!newsOnly) startLive();
}

async function loadNewsPage(id, { initial = false } = {}) {
  if (!initial) {
    app.hidden = true;
    newsView.hidden = false;
    intersectionObserver?.unobserve(sentinel);
  }
  state.newsId = Number(id);
  if (!initial) newsView.innerHTML = '<div class="news-page"><div class="news-skeleton" aria-hidden="true"><div class="sk-cover"></div><div class="sk-body"><span class="sk-line sk-short"></span><span class="sk-line"></span><span class="sk-line sk-mid"></span><span class="sk-line"></span><span class="sk-line sk-tiny"></span></div></div></div>';
  try {
    const { item } = await getJson(`/api/public/news/${id}`);
    state.newsId = Number(item.id);
    const target = initial ? app : newsView;
    target.innerHTML = renderNewsPage(item, initial);
    target.hidden = false;
    if (!initial) app.hidden = true;
    document.title = `${item.title} — ${state.config?.site_title || 'اخبار پیام‌نور'}`;
    if ('mediaSession' in navigator) dock.setMediaMetadata(item.title, item.publisher_unit);
  } catch (error) {
    const target = initial ? app : newsView;
    target.innerHTML = `<section class="reader-error"><h1>خبر پیدا نشد</h1><p>${escapeHtml(error.message)}</p><a class="news-back" href="/">بازگشت به خبرها</a></section>`;
    target.hidden = false;
  }
}

let galleryImages = [];

function renderNewsPage(item, initial) {
  // Two lines: the person, then the university unit (e.g. "دانشگاه پیام‌نور بیجار").
  const signatureParts = [item.publisher_name ? `<strong>${escapeHtml(item.publisher_name)}</strong>` : '', item.publisher_unit ? `<span>${escapeHtml(item.publisher_unit)}</span>` : ''].filter(Boolean);
  const signature = signatureParts.length ? `<p class="news-signature">${signatureParts.join('')}</p>` : '';
  const category = item.category?.name ? `<span>${escapeHtml(item.category.name)}</span>` : '';
  const date = new Date(item.published_at);
  const fullDate = `${dateFormatter.format(date)} — ${timeFormatter.format(date)}`;
  const cover = item.cover?.src ? `<div class="news-page-cover-frame">${placeholderMarkup(item.cover.dominant_color)}<img class="news-page-cover" referrerpolicy="no-referrer" src="${escapeHtml(item.cover.src)}" srcset="${escapeHtml(item.cover.srcset ?? '')}" sizes="(max-width: 790px) 100vw, 790px" width="${Number(item.cover.width) || 1280}" height="${Number(item.cover.height) || 720}" fetchpriority="high" alt="${escapeHtml(item.title)}"></div>` : '';
  // Attached images except the cover; clicking one opens the lightbox (see openLightbox).
  galleryImages = (item.images ?? []).filter((image) => image.src && Number(image.id) !== Number(item.cover?.id));
  const gallery = galleryImages.map((image, index) => `<button type="button" class="gallery-image-frame" data-lightbox-index="${index}" aria-label="${escapeHtml(`نمایش بزرگ تصویر ${digits.format(index + 1)} از ${digits.format(galleryImages.length)}`)}">${placeholderMarkup(image.dominant_color)}<img src="${escapeHtml(image.src)}" srcset="${escapeHtml(image.srcset ?? '')}" sizes="(max-width: 767px) 100vw, 50vw" width="${Number(image.width) || 800}" height="${Number(image.height) || 600}" loading="lazy" decoding="async" alt="${escapeHtml(image.original_name)}"></button>`).join('');
  const files = (item.files ?? []).map((file) => `<a class="attachment-link" href="${escapeHtml(file.url)}"><span>▤ ${escapeHtml(file.original_name)}</span><span>${escapeHtml(formatBytes(file.size_bytes))}</span></a>`).join('');
  return `${initial ? '' : '<a class="news-back" href="/" data-reader-back><svg class="icon"><use href="#icon-chevron"/></svg>بازگشت به خبرها</a>'}
    <article class="news-page">${cover}<h1>${escapeHtml(item.title)}</h1>
    <div class="news-details">${category}<time datetime="${escapeHtml(item.published_at)}">${fullDate}</time><span>${digits.format(item.view_count)} بازدید</span></div>
    <div class="news-body">${item.body_html}</div>
    ${signature}
    ${gallery ? `<section class="news-gallery" aria-label="تصاویر خبر">${gallery}</section>` : ''}
    ${files ? `<section class="attachment-list"><h2>پیوست‌ها</h2>${files}</section>` : ''}
    <div class="news-actions"><button type="button" class="share-button" data-share><svg class="icon"><use href="#icon-share"/></svg>اشتراک‌گذاری خبر</button></div>
    </article>`;
}

// ---------- Lightbox for attached images ----------
const lightbox = document.getElementById('lightbox');
const lightboxImage = document.getElementById('lightbox-image');
const lightboxCaption = document.getElementById('lightbox-caption');
const lightboxPrev = document.getElementById('lightbox-prev');
const lightboxNext = document.getElementById('lightbox-next');
let lightboxIndex = 0;
let lightboxOpener = null;

function showLightboxImage(index) {
  const total = galleryImages.length;
  if (!total) return;
  lightboxIndex = (index + total) % total;
  const image = galleryImages[lightboxIndex];
  lightboxImage.removeAttribute('srcset');
  lightboxImage.sizes = '100vw';
  lightboxImage.srcset = image.srcset ?? '';
  lightboxImage.src = image.src;
  lightboxImage.alt = image.original_name ?? '';
  lightboxCaption.textContent = total > 1 ? `${digits.format(lightboxIndex + 1)} از ${digits.format(total)}` : '';
  lightboxPrev.hidden = lightboxNext.hidden = total < 2;
  for (const neighbour of [galleryImages[(lightboxIndex + 1) % total], galleryImages[(lightboxIndex + total - 1) % total]]) {
    if (neighbour && neighbour !== image) new Image().src = neighbour.src;
  }
}

function openLightbox(index, opener) {
  if (!lightbox || !galleryImages[index]) return;
  lightboxOpener = opener ?? null;
  showLightboxImage(index);
  if (!lightbox.open) lightbox.showModal();
}

if (lightbox) {
  document.addEventListener('click', (event) => {
    const opener = event.target.closest?.('[data-lightbox-index]');
    if (opener) openLightbox(Number(opener.dataset.lightboxIndex), opener);
  });
  lightboxPrev.addEventListener('click', () => showLightboxImage(lightboxIndex - 1));
  lightboxNext.addEventListener('click', () => showLightboxImage(lightboxIndex + 1));
  lightbox.querySelector('.lightbox-close').addEventListener('click', () => lightbox.close());
  // A click on the dark area (not the image or a button) closes it.
  lightbox.addEventListener('click', (event) => {
    if (event.target === lightbox || event.target.classList.contains('lightbox-figure')) lightbox.close();
  });
  // The page is right-to-left: the left arrow goes forward, the right arrow goes back.
  lightbox.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') { event.preventDefault(); showLightboxImage(lightboxIndex + 1); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); showLightboxImage(lightboxIndex - 1); }
  });
  let touchStartX = null;
  lightbox.addEventListener('touchstart', (event) => { touchStartX = event.touches.length === 1 ? event.touches[0].clientX : null; }, { passive: true });
  lightbox.addEventListener('touchend', (event) => {
    if (touchStartX === null) return;
    const delta = event.changedTouches[0].clientX - touchStartX;
    touchStartX = null;
    if (Math.abs(delta) > 60) showLightboxImage(lightboxIndex + (delta < 0 ? 1 : -1));
  }, { passive: true });
  lightbox.addEventListener('close', () => {
    lightboxImage.removeAttribute('src');
    lightboxImage.removeAttribute('srcset');
    lightboxOpener?.focus?.({ preventScroll: true });
    lightboxOpener = null;
  });
}

// ---------- Settings and about dialogs ----------
const settingsDialog = document.getElementById('settings-dialog');
const aboutDialog = document.getElementById('about-dialog');

let feedPrefsStale = false;

function renderSettings() {
  for (const input of settingsDialog.querySelectorAll('[data-pref]')) input.checked = Boolean(prefs[input.dataset.pref]);
  const province = state.province?.name;
  document.getElementById('pref-province-title').textContent = province ? `خبرهای استان ${province}` : 'خبرهای استان من';
  document.getElementById('pref-siblings-hint').textContent = province
    ? `خبرهای دیگر مراکز دانشگاهی استان ${province}` : 'خبرهای دیگر مراکز دانشگاهی استان شما';
}

document.getElementById('settings-button').addEventListener('click', () => {
  renderSettings();
  settingsDialog.showModal();
});
settingsDialog.addEventListener('change', (event) => {
  const key = event.target.dataset?.pref;
  if (!(key in DEFAULT_PREFS)) return;
  prefs[key] = event.target.checked;
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {}
  if (key === 'radio') applyRadioPreference();
  else if (state.city && !state.newsId) resetFeed();
  else feedPrefsStale = true;
});

document.getElementById('about-button').addEventListener('click', () => {
  const version = /app\.v([\d.]+)\.js/.exec(import.meta.url)?.[1] ?? '';
  document.getElementById('about-version').textContent = version.replace(/\d/g, (digit) => '۰۱۲۳۴۵۶۷۸۹'[digit]);
  aboutDialog.showModal();
});

for (const dialog of [settingsDialog, aboutDialog]) {
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog || event.target.closest('[data-dialog-close]')) dialog.close();
  });
}

// Opens the chat in the Telegram app when it is installed, otherwise the web page (t.me) opens in a new tab.
document.getElementById('about-telegram').addEventListener('click', (event) => {
  event.preventDefault();
  const webUrl = event.currentTarget.href;
  let left = false;
  const markLeft = () => { left = true; };
  window.addEventListener('blur', markLeft, { once: true });
  document.addEventListener('visibilitychange', markLeft, { once: true });
  location.href = 'tg://resolve?domain=RealDream';
  setTimeout(() => {
    window.removeEventListener('blur', markLeft);
    document.removeEventListener('visibilitychange', markLeft);
    if (!left) window.open(webUrl, '_blank', 'noopener,noreferrer');
  }, 1600);
});

function formatBytes(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${digits.format(size)} بایت`;
  if (size < 1024 * 1024) return `${digits.format((size / 1024).toFixed(1))} کیلوبایت`;
  return `${digits.format((size / (1024 * 1024)).toFixed(1))} مگابایت`;
}

async function shareCurrentNews() {
  const url = location.href;
  const title = document.querySelector('#news-view h1, #app h1')?.textContent || document.title;
  try {
    if (navigator.share) await navigator.share({ title, url });
    else if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      showToast('پیوند خبر کپی شد.');
    } else {
      const input = document.createElement('textarea');
      input.value = url;
      input.setAttribute('readonly', '');
      input.className = 'copy-fallback';
      document.body.append(input);
      input.select();
      document.execCommand('copy');
      input.remove();
      showToast('پیوند خبر کپی شد.');
    }
  } catch (error) {
    if (error.name !== 'AbortError') showToast('اشتراک‌گذاری انجام نشد.');
  }
}

function navigateToNews(id) {
  history.replaceState({ ...(history.state ?? {}), readerScrollY: window.scrollY }, '', location.href);
  history.pushState({ readerEntry: true, readerScrollY: window.scrollY }, '', `/n/${id}`);
  loadNewsPage(id);
  window.scrollTo(0, 0);
}

function returnToFeed() {
  state.newsId = null;
  document.title = state.config?.site_title || 'اخبار پیام‌نور';
  newsView.hidden = true;
  app.hidden = false;
  intersectionObserver?.observe(sentinel);
  const scrollY = Number(history.state?.readerScrollY) || 0;
  if (feedPrefsStale) {
    feedPrefsStale = false;
    resetFeed({ scroll: true });
    return;
  }
  requestAnimationFrame(() => {
    window.scrollTo(0, scrollY);
    if (liveDirty) syncFeed();
  });
}

// ---------- Service worker & install suggestion ----------
const INSTALL_SNOOZE_KEY = 'pnu.installDismissedAt';
const INSTALL_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;
let deferredInstall = null;

function isStandalone() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function installSnoozed() {
  try {
    const at = Number(localStorage.getItem(INSTALL_SNOOZE_KEY));
    return Boolean(at) && Date.now() - at < INSTALL_SNOOZE_MS;
  } catch { return false; }
}

function snoozeInstall() {
  try { localStorage.setItem(INSTALL_SNOOZE_KEY, String(Date.now())); } catch {}
}

function isIos() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

// Adding ?install=1 to the address forces the suggestion to show again (ignores a previous dismissal) for testing.
const forceInstallHint = new URLSearchParams(location.search).has('install');

function hideInstallBanner() {
  installRoot?.replaceChildren();
}

function showInstallBanner(mode) {
  if (!installRoot || installRoot.childElementCount || isStandalone() || (installSnoozed() && !forceInstallHint)) return;
  const text = mode === 'ios'
    ? 'روی دکمهٔ اشتراک‌گذاری (مربع با فلش) بزنید و «افزودن به صفحهٔ اصلی» را انتخاب کنید.'
    : 'برای دسترسی سریع‌تر، برنامه را روی دستگاه خود نصب کنید.';
  const action = mode === 'ios' ? '' : '<button type="button" class="button-primary" data-install-accept>نصب</button>';
  installRoot.innerHTML = `<div class="install-banner" role="region" aria-label="نصب برنامه"><img src="/icons/pnu-logo.v3.png" width="40" height="40" alt="" aria-hidden="true"><div class="install-text"><strong>نصب اخبار پیام‌نور</strong><span>${text}</span></div>${action}<button type="button" class="icon-button" data-install-dismiss aria-label="بستن"><svg class="icon"><use href="#icon-close"/></svg></button></div>`;
}

// A new service worker waits until the visitor accepts the update banner, then the page reloads on the new version.
let waitingWorker = null;
let swRegistration = null;
let controlled = Boolean(navigator.serviceWorker?.controller);

function showUpdateBanner(worker) {
  waitingWorker = worker; // always track the newest waiting worker, even while the banner is already open
  if (!updateRoot || updateRoot.childElementCount) return;
  updateRoot.innerHTML = '<div class="install-banner" role="status"><img src="/icons/pnu-logo.v3.png" width="40" height="40" alt="" aria-hidden="true"><div class="install-text"><strong>نسخهٔ جدید آماده است</strong><span>برای دریافت آخرین تغییرات، برنامه را به‌روزرسانی کنید.</span></div><button type="button" class="button-primary" data-update-accept>به‌روزرسانی</button><button type="button" class="icon-button" data-update-dismiss aria-label="بعداً"><svg class="icon"><use href="#icon-close"/></svg></button></div>';
}

// All open tabs of the app follow an update: the tab that applies it tells the others, and they reload in the
// background. The service worker's own "controllerchange" already reaches tabs it controls; this channel also
// covers tabs it does not (opened with a hard refresh, or browsers that deliver the event late to hidden tabs).
const updateChannel = 'BroadcastChannel' in window ? new BroadcastChannel('pnu-app-update') : null;
let reloadingForUpdate = false;
let reloadPending = false;

function reloadForUpdate() {
  if (reloadingForUpdate) return;
  reloadingForUpdate = true;
  location.reload();
}

updateChannel?.addEventListener('message', (event) => {
  if (event.data?.type !== 'reload') return;
  reloadPending = true;
  reloadForUpdate();
});
// A tab the browser has frozen in the background may not reload right away; finish the job when it is shown again.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && reloadPending) { reloadingForUpdate = false; reloadForUpdate(); }
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!controlled) { controlled = true; return; } // first install taking control: nothing to reload
    reloadPending = true;
    updateChannel?.postMessage({ type: 'reload' });
    reloadForUpdate();
  });
  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js');
      swRegistration = registration;
      const announce = (worker) => worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) showUpdateBanner(worker);
      });
      if (registration.waiting && navigator.serviceWorker.controller) showUpdateBanner(registration.waiting);
      if (registration.installing) announce(registration.installing);
      registration.addEventListener('updatefound', () => registration.installing && announce(registration.installing));
      const check = () => registration.update().catch(() => {});
      document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
      setInterval(check, 60 * 60 * 1000);
    } catch {}
  });
}
updateRoot?.addEventListener('click', (event) => {
  if (event.target.closest('[data-update-dismiss]')) {
    updateRoot.replaceChildren();
    return;
  }
  const accept = event.target.closest('[data-update-accept]');
  const worker = swRegistration?.waiting ?? waitingWorker; // a newer release may have replaced the one the banner was opened for
  if (!accept || !worker) return;
  accept.disabled = true;
  accept.textContent = 'در حال به‌روزرسانی…';
  worker.postMessage({ type: 'SKIP_WAITING' });
  setTimeout(() => { updateChannel?.postMessage({ type: 'reload' }); reloadForUpdate(); }, 4000); // safety net if the worker never reports control
});
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstall = event;
  setTimeout(() => { if (deferredInstall) showInstallBanner('prompt'); }, 3000);
});
window.addEventListener('appinstalled', () => {
  deferredInstall = null;
  hideInstallBanner();
});
if (isIos() && !isStandalone()) setTimeout(() => showInstallBanner('ios'), 4000);
installRoot?.addEventListener('click', async (event) => {
  if (event.target.closest('[data-install-dismiss]')) {
    snoozeInstall();
    hideInstallBanner();
    return;
  }
  if (!event.target.closest('[data-install-accept]') || !deferredInstall) return;
  const promptEvent = deferredInstall;
  deferredInstall = null;
  hideInstallBanner();
  try {
    await promptEvent.prompt();
    const { outcome } = await promptEvent.userChoice;
    if (outcome !== 'accepted') snoozeInstall();
  } catch {}
});

document.getElementById('city-button').addEventListener('click', openPicker);
document.addEventListener('error', (event) => {
  if (!(event.target instanceof HTMLImageElement) || event.target.classList.contains('cover-placeholder')) return;
  if (event.target.classList.contains('card-cover') || event.target.classList.contains('news-page-cover') || event.target.closest('.gallery-image-frame,.pinned-cover-frame')) event.target.hidden = true;
}, true);
document.querySelector('.picker-close').addEventListener('click', () => picker.close());
picker.addEventListener('click', (event) => {
  if (event.target === picker) {
    picker.close();
    return;
  }
  const provinceButton = event.target.closest('[data-province-id]');
  if (provinceButton) {
    state.pickerProvince = state.config.provinces.find((province) => Number(province.id) === Number(provinceButton.dataset.provinceId)) ?? null;
    pickerSearch.value = '';
    renderPickerList();
    pickerList.scrollTop = 0;
    focusPickerSearch();
    return;
  }
  const cityButton = event.target.closest('[data-city-id]');
  if (cityButton) {
    const found = findCity(cityButton.dataset.cityId);
    if (found) setCity(found.city, found.province);
  }
});
pickerBack.addEventListener('click', () => {
  state.pickerProvince = null;
  pickerSearch.value = '';
  renderPickerList();
  pickerList.scrollTop = 0;
  focusPickerSearch();
});
pickerSearch.addEventListener('input', renderPickerList);
feed.addEventListener('click', (event) => {
  if (event.target.closest('[data-open-picker]')) {
    openPicker();
    return;
  }
  const card = event.target.closest('[data-news-id]');
  if (card) openCard(card);
});
pinnedStrip.addEventListener('click', (event) => {
  const card = event.target.closest('[data-news-id]');
  if (card) openCard(card);
});
feed.addEventListener('keydown', (event) => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-news-id]')) {
    event.preventDefault();
    openCard(event.target);
  }
});
pinnedStrip.addEventListener('keydown', (event) => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-news-id]')) {
    event.preventDefault();
    openCard(event.target);
  }
});
newItemsBanner.addEventListener('click', () => resetFeed({ scroll: true }));
app.addEventListener('click', (event) => {
  if (event.target.closest('[data-share]')) shareCurrentNews();
});
newsView.addEventListener('click', (event) => {
  if (event.target.closest('[data-share]')) shareCurrentNews();
  if (event.target.closest('[data-reader-back]')) {
    event.preventDefault();
    if (history.state?.readerEntry) history.back();
    else location.assign('/');
  }
});
window.addEventListener('popstate', () => {
  const match = /^\/n\/(\d+)$/.exec(location.pathname);
  if (match) loadNewsPage(match[1]);
  else if (state.newsId) returnToFeed();
});

const initialNewsMatch = /^\/n\/(\d+)$/.exec(location.pathname);
if (initialNewsMatch) {
  initializeReader({ newsOnly: true }).then(() => loadNewsPage(initialNewsMatch[1]));
} else {
  initializeReader();
}
