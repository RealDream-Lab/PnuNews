import { initDock } from '/shared/dock.v0.1.146.js';
import { itemSignature, planLiveUpdate, pinnedSignature } from '/shared/live-plan.v0.1.146.js';
import { matchesQuery, parseQuery, searchKey } from '/shared/quick-search.v0.1.146.js';
import { fetchOrExplain } from '/shared/network-error.v0.1.146.js';
import { createBookmarkStore, MAX_BOOKMARKS, snapFromItem, BOOKMARKS_KEY } from '/shared/bookmarks.v0.1.146.js';

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
const categoryDialog = document.getElementById('category-dialog');
const categoryButton = document.getElementById('category-button');
const categoryList = document.getElementById('category-list');
const searchButton = document.getElementById('search-button');
const quickSearch = document.getElementById('quick-search');
const quickSearchInput = document.getElementById('quick-search-input');
const quickSearchCount = document.getElementById('quick-search-count');
const quickSearchClose = document.getElementById('quick-search-close');
const searchEmpty = document.getElementById('search-empty');
const pinnedWrap = document.querySelector('.pinned-wrap');
// The reader's account card: the first card of the strip (before the prayer card). It replaces the old header button, so the
// node is made here and put into the strip by syncPrayerCard(); the account dialog opens when it is tapped.
const accountButton = document.createElement('button');
accountButton.type = 'button';
accountButton.id = 'account-button';
accountButton.className = 'account-card is-guest';
accountButton.setAttribute('aria-haspopup', 'dialog');
accountButton.hidden = true;

// ---------- Loading layer ----------
// The spiral in index.html covers the page until the first screen is really ready (feed or article drawn, fonts and the
// pictures in view loaded, at most about two seconds of waiting for those), then fades out. It also lifts after 8 s
// whatever happens, and the stylesheet lifts it by itself after 12 s even if this script never runs.
const pageLoader = document.getElementById('page-loader');
let loaderDone = false;
async function finishLoading() {
  if (loaderDone || !pageLoader) return;
  loaderDone = true;
  const settle = (image) => (image.complete ? Promise.resolve() : new Promise((resolve) => {
    image.addEventListener('load', resolve, { once: true });
    image.addEventListener('error', resolve, { once: true });
  }));
  const inView = (image) => {
    const box = image.getBoundingClientRect();
    return box.width > 0 && box.bottom > 0 && box.top < innerHeight;
  };
  const pictures = [...document.querySelectorAll('.news-card img, .pinned-card img, .news-page img')].filter(inView).slice(0, 6);
  await Promise.race([
    Promise.all([document.fonts?.ready, ...pictures.map(settle)]),
    new Promise((resolve) => setTimeout(resolve, 1800)),
  ]);
  // Two frames: what shows under the layer when it starts to fade is the finished layout, not a half-drawn one.
  // A page that is hidden or being restored by the browser delivers no frames, so the wait is capped.
  await Promise.race([
    new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    new Promise((resolve) => setTimeout(resolve, 250)),
  ]);
  pageLoader.classList.add('is-leaving');
  const remove = () => pageLoader.remove();
  pageLoader.addEventListener('transitionend', remove, { once: true });
  setTimeout(remove, 900);
}
setTimeout(finishLoading, 8000);
// Coming back with the browser's back button can hand the page over as it was left: whatever is left of the layer goes at once.
addEventListener('pageshow', (event) => { if (event.persisted) pageLoader?.remove(); });

const state = {
  config: null,
  city: null,
  province: null,
  pickerProvince: null,
  scope: 'all', // always "all" for now; will become a setting later
  category: null, // null = all categories; otherwise the chosen category id
  categories: [], // chips for this reader's center: only categories with news, each with its count
  cursor: null,
  loading: false,
  ended: false,
  entries: [],
  recycled: [], // cards taken off the top (their data + an empty same-size ghost in their place), brought back when the reader scrolls up to them
  pinnedIds: new Set(),
  pinnedSig: '',
  firstId: null,
  newsId: null,
  newsOnly: false, // opened straight on /n/<id>: the article is rendered into #app instead of #news-view
  refreshTimer: null,
  toastTimer: null,
  fontScale: 1,
  searchTokens: [], // words of the quick search; empty = every card is shown
};
let intersectionObserver = null;
let loadRetryTimer = 0;

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

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('is-visible');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2600);
}

const dock = initDock({ showToast });

// Saved news (bookmarks) live on this device only; see /shared/bookmarks. Created early because cards read it when they are drawn.
const bookmarks = createBookmarkStore({ storage: (() => { try { return localStorage; } catch { return null; } })() });
// The important/urgent items currently in the strip, so a tap on the bookmark of one of those small cards can save its snapshot.
const pinnedItems = new Map();

// ---------- Reader preferences (stored on this device only) ----------
const PREFS_KEY = 'pnu.prefs';
const AUTOPLAY_RESET_KEY = 'pnu.autoplay-off';
const DEFAULT_PREFS = Object.freeze({ radio: true, autoplay: false, country: true, province: true, siblings: false });
const prefs = { ...DEFAULT_PREFS };
try {
  const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
  if (saved && typeof saved === 'object') {
    for (const key of Object.keys(DEFAULT_PREFS)) if (typeof saved[key] === 'boolean') prefs[key] = saved[key];
  }
  // Autoplay used to be on by default, so a stored "true" may never have been the reader's own choice. Once per
  // device it is switched off; after that the stored value is respected again.
  if (localStorage.getItem(AUTOPLAY_RESET_KEY) !== '1') {
    localStorage.setItem(AUTOPLAY_RESET_KEY, '1');
    if (prefs.autoplay) {
      prefs.autoplay = false;
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    }
  }
} catch {}

function applyRadioPreference() {
  document.documentElement.classList.toggle('radio-hidden', !prefs.radio);
  if (!prefs.radio) dock.stopRadio();
}

// Autoplay needs the radio to be shown and the reader to allow it; it is tried once per page load.
function maybeAutoplayRadio() {
  if (prefs.radio && prefs.autoplay) dock.autoplayRadio();
}
applyRadioPreference();

// ---------- Category filter (stored on this device only; default is "all") ----------
const CATEGORY_KEY = 'pnu.category';
try {
  const savedCategory = Number(localStorage.getItem(CATEGORY_KEY));
  if (Number.isSafeInteger(savedCategory) && savedCategory > 0) state.category = savedCategory;
} catch {}

function categoryParams() {
  return state.category ? { category: String(state.category) } : {};
}

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
  const response = await fetchOrExplain(url, { headers: { accept: 'application/json' } });
  let body;
  try { body = await response.json(); } catch { body = {}; }
  if (!response.ok) {
    const error = new Error(body.error || 'دریافت اطلاعات ناموفق بود.');
    error.status = response.status;
    error.retryAfter = Number(response.headers.get('retry-after')) || 0; // seconds, sent with HTTP 429
    throw error;
  }
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
  if (item.scope.type === 'city') return `دانشگاه پیام‌نور ${item.scope.name}`;
  return '';
}

// Card label: "خبرهای دانشگاه پیام‌نور <شهر منتشرکننده>" instead of the category.
function publisherLabel(item) {
  if (item.scope.type === 'country') return 'خبرهای سازمان مرکزی پیام‌نور';
  if (item.scope.type === 'province') return `خبرهای دانشگاه پیام‌نور استان ${item.scope.name}`;
  if (item.scope.type === 'city') return `خبرهای دانشگاه پیام‌نور ${item.scope.name}`;
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

// Same share icon as Google's own apps: three linked dots on Android and everywhere else, the box-with-arrow on iOS/iPadOS.
const IS_APPLE_TOUCH = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const SHARE_ICON = IS_APPLE_TOUCH ? '#icon-share-ios' : '#icon-share-android';

// Icon-only version of the news page's share button: no circle, at the left end of the card's meta line (on the strip over the cover, or in the footer line without a cover).
function cardShareMarkup() {
  return `<button type="button" class="card-share" data-share-card aria-label="اشتراک‌گذاری خبر" title="اشتراک‌گذاری خبر"><svg class="icon" aria-hidden="true"><use href="${SHARE_ICON}"/></svg></button>`;
}

// Bookmark icon next to the share icon. The state is drawn from the store when the card is built and kept in step later by syncSavedUi.
function cardSaveMarkup(item) {
  const saved = bookmarks.has(item.id);
  return `<button type="button" class="card-save${saved ? ' is-saved' : ''}" data-save-card aria-pressed="${saved}" aria-label="ذخیرهٔ خبر" title="${saved ? 'حذف از خبرهای ذخیره‌شده' : 'ذخیرهٔ خبر'}"><svg class="icon" aria-hidden="true"><use href="#icon-bookmark"/></svg></button>`;
}

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

// The small important/urgent cards show the summary (چکیده) instead of the title; a news without a summary shows its title,
// so a card is never empty. The title stays the card's accessible name (aria-label) and, like the summary, is searchable.
function pinnedText(item) {
  const summary = typeof item.summary === 'string' ? item.summary.trim() : '';
  return summary || item.title;
}

function pinnedMarkup(item) {
  pinnedItems.set(Number(item.id), item);
  const thumbnail = item.cover?.src
    ? `<div class="pinned-cover-frame">${placeholderMarkup(item.cover.dominant_color)}<img referrerpolicy="no-referrer" src="${escapeHtml(item.cover.src)}" width="104" height="59" loading="lazy" alt=""></div>`
    : '';
  const classes = ['pinned-card', item.is_urgent ? 'is-urgent' : '', thumbnail ? '' : 'no-thumb'].filter(Boolean).join(' ');
  return `<article class="${classes}" data-news-id="${item.id}"${externalAttributes(item)} tabindex="0" role="link" aria-label="${escapeHtml(item.title)}" data-search-summary="${escapeHtml(item.summary ?? '')}">${thumbnail}<div><div class="card-meta"><span class="card-kicker">${item.is_urgent ? 'خبر فوری' : 'خبر مهم'}</span>${cardSaveMarkup(item)}</div><h2>${escapeHtml(pinnedText(item))}</h2></div></article>`;
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
      : `<div class="card-content"><h2>${escapeHtml(item.title)}</h2>${portalSummary}<div class="card-foot">${line}${cardSaveMarkup(item)}${cardShareMarkup()}</div></div>`;
    return `<article class="${portalClasses}" data-news-id="${item.id}"${externalAttributes(item)} data-scope="${escapeHtml(item.scope.type)}" tabindex="0" role="link" aria-label="${escapeHtml(item.title)}">
    ${hasCover ? coverMarkup(item, featured, `<div class="card-meta-overlay"><div class="overlay-row">${line}</div>${cardSaveMarkup(item)}${cardShareMarkup()}</div>`) : ''}
    ${portalBody}
  </article>`;
  }
  const label = publisherLabel(item);
  const badge = '';
  const category = label ? `<span class="card-kicker publisher-kicker" data-scope="${escapeHtml(item.scope.type)}">${escapeHtml(label)}</span>` : '';
  const urgent = item.is_urgent ? '<span class="urgent-label">فوری</span>' : '';
  const source = item.publisher_unit ? `<span class="card-source">${escapeHtml(item.publisher_unit)}</span><i aria-hidden="true"></i>` : '';
  const time = `<time datetime="${escapeHtml(item.published_at)}">${relativeDate(item.published_at)}</time>`;
  const summary = item.summary ? `<p class="card-summary">${escapeHtml(item.summary)}</p>` : '';
  const classes = ['news-card', item.is_urgent ? 'is-urgent' : '', hasCover ? '' : 'no-cover', featured ? 'is-featured' : ''].filter(Boolean).join(' ');
  // With a cover, all meta sits on a translucent black strip over the image; only title and summary stay below it.
  // Always at most two lines: related labels share the first line, source and time share the second.
  const labels = badge || category || urgent ? `<div class="overlay-row">${badge}${category}${urgent}</div>` : '';
  const overlay = `<div class="card-meta-overlay">${labels}<div class="overlay-row">${source}${time}</div>${cardSaveMarkup(item)}${cardShareMarkup()}</div>`;
  const body = hasCover
    ? `<div class="card-content"><h2>${escapeHtml(item.title)}</h2>${summary}</div>`
    : `<div class="card-content">${badge || category || urgent ? `<div class="card-meta">${badge}${category}${urgent}</div>` : ''}<h2>${escapeHtml(item.title)}</h2>${summary}<div class="card-foot">${source}${time}${cardSaveMarkup(item)}${cardShareMarkup()}</div></div>`;
  return `<article class="${classes}" data-news-id="${item.id}"${externalAttributes(item)} data-scope="${escapeHtml(item.scope.type)}" tabindex="0" role="link" aria-label="${escapeHtml(item.title)}">
    ${hasCover ? coverMarkup(item, featured, overlay) : ''}
    ${body}
  </article>`;
}

// Masonry (tablets, laptops and desktops: every size where the cards sit in two or three columns): the feed is a grid of 8px
// rows and every card spans as many rows as its own height needs, so cards of different heights pack tightly without
// leaving gaps. A phone (one column) keeps the plain grid.
const MASONRY_ROW = 8;
const masonryQuery = matchMedia('(min-width: 640px)');

function layoutMasonry() {
  const active = masonryQuery.matches;
  feed.classList.toggle('is-masonry', active);
  const nodes = [...feed.children];
  if (!active) {
    for (const node of nodes) node.style.gridRowEnd = '';
    return;
  }
  const gap = Number.parseFloat(getComputedStyle(feed).columnGap) || 16;
  const heights = nodes.map((node) => node.getBoundingClientRect().height);
  nodes.forEach((node, index) => {
    node.style.gridRowEnd = `span ${Math.max(1, Math.ceil((heights[index] + gap) / MASONRY_ROW))}`;
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
  fitCoverFrame(image);
}

// The frames crop their picture (`object-fit: cover`), so a portrait one, a poster that is only a little off 16:9, or a
// very wide banner would lose its edges. A picture whose shape differs from its frame's by more than this share is shown
// whole instead, centred over a blurred copy of itself (the `.is-contained` CSS). Raise it to crop more, lower it to crop less.
// Feed cards are the exception: there only a portrait picture (narrower than it is tall) is shown whole; every
// landscape one fills the whole card frame, however far its shape is from the frame's.
const COVER_SHAPE_TOLERANCE = 0.06;
function fitCoverFrame(image) {
  const frame = image.closest('.card-cover-frame, .pinned-cover-frame, .news-page-cover-frame, .gallery-image-frame');
  if (!frame || image.classList.contains('cover-placeholder') || !image.naturalWidth || !image.naturalHeight) return;
  const frameRatio = frame.offsetWidth && frame.offsetHeight ? frame.offsetWidth / frame.offsetHeight : 16 / 9;
  const contained = frame.classList.contains('card-cover-frame')
    ? image.naturalWidth < image.naturalHeight
    : Math.abs(image.naturalWidth / image.naturalHeight / frameRatio - 1) > COVER_SHAPE_TOLERANCE;
  frame.classList.toggle('is-contained', contained);
  if (contained) frame.style.setProperty('--cover-bg', `url("${image.currentSrc || image.src}")`);
  else frame.style.removeProperty('--cover-bg');
}
document.addEventListener('load', (event) => {
  const target = event.target;
  if (target.matches?.('img.card-cover, .pinned-cover-frame img')) settleCover(target);
  else if (target.matches?.('img.news-page-cover, .gallery-image-frame img')) fitCoverFrame(target);
}, true);
document.addEventListener('error', (event) => {
  if (event.target.matches?.('img.card-cover, .pinned-cover-frame img')) event.target.closest('.card-cover-frame, .pinned-cover-frame')?.classList.add('is-failed');
}, true);

function watchFeedNode(node) {
  if (node.nodeType !== 1) return;
  if (!node.classList.contains('feed-ghost') && !node.classList.contains('news-skeleton')) masonryObserver?.observe(node);
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
  const perRow = matchMedia('(min-width: 960px)').matches ? 3 : masonryQuery.matches ? 2 : 1;
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

function emptyFeedMarkup() {
  const text = state.category ? 'در این دسته هنوز خبری منتشر نشده است.' : 'در این محدوده هنوز خبری منتشر نشده است.';
  return `<div class="empty-state">${text}</div>`;
}

function clearFeed() {
  intersectionObserver?.unobserve(sentinel);
  feed.replaceChildren();
  state.entries = [];
  state.recycled = [];
  state.pinnedIds = new Set();
  state.pinnedSig = '';
  state.cursor = null;
  state.ended = false;
  state.firstId = null;
  liveDirty = false;
  freshPending = false;
  pinnedStrip.replaceChildren();
  pinnedStrip.hidden = true;
  syncPrayerCard();
  newItemsBanner.hidden = true;
}

function resetFeed({ scroll = false } = {}) {
  clearFeed();
  refreshCategories();
  if (!state.city) {
    feedMessage.textContent = '';
    feed.innerHTML = '<div class="empty-state"><p>برای دیدن خبرها، ابتدا مرکز دانشگاهی خود را انتخاب کنید.</p><button type="button" class="button-primary" data-open-picker>انتخاب مرکز دانشگاهی</button></div>';
    return;
  }
  feedMessage.textContent = '';
  if (scroll) {
    const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    window.scrollTo({ top: 0, behavior });
  }
  loadMore();
}

// Cards far above the viewport are turned into ghosts: the card's DOM (image, text) goes, an empty box of exactly the
// same size and the same grid placement stays. Every other card therefore keeps its column and position; a single
// stretched spacer would make the masonry pack the remaining cards again from a flat line and they would jump.
function recycleFeed() {
  if (state.searchTokens.length) return; // a search needs every loaded card in the page
  const excess = state.entries.length - 60;
  if (excess <= 0) return;
  const removed = state.entries.splice(0, excess);
  for (const entry of removed) {
    const featured = entry.node.classList.contains('is-featured');
    const ghost = document.createElement('div');
    ghost.className = `feed-ghost${featured ? ' is-featured' : ''}`;
    ghost.setAttribute('aria-hidden', 'true');
    ghost.style.height = `${entry.node.getBoundingClientRect().height}px`;
    ghost.style.gridRowEnd = entry.node.style.gridRowEnd;
    entry.node.replaceWith(ghost);
    state.recycled.push({ id: entry.id, item: entry.item, featured, ghost });
  }
}

// The other direction: cards recycled off the top are only a blank spacer. When the reader scrolls back up towards it
// (fast scrolling included) a few of them are rebuilt, newest first, well before the blank comes on screen, and the spacer
// shrinks by what they take up. A visible card is used as the anchor so the page never jumps while this happens.
let glideShiftHook = null;
const RESTORE_AHEAD = 2000;
const RESTORE_BATCH = 9;
let restoreFrame = 0;
function scheduleRestore() {
  if (restoreFrame || !state.recycled.length) return;
  restoreFrame = requestAnimationFrame(restoreRecycled);
}

function restoreRecycled() {
  restoreFrame = 0;
  if (!state.recycled.length) return;
  const nearest = state.recycled.at(-1).ghost;
  if (nearest.getBoundingClientRect().bottom < -RESTORE_AHEAD) return;
  const batch = state.recycled.splice(-Math.min(state.recycled.length, RESTORE_BATCH));
  const anchor = state.entries.find((entry) => entry.node.getBoundingClientRect().bottom > 0) ?? null;
  const anchorTop = anchor?.node.getBoundingClientRect().top ?? 0;
  const restored = batch.map(({ id, item, featured, ghost }) => {
    const node = createCardNode(item, featured);
    node.style.gridRowEnd = ghost.style.gridRowEnd; // same place until the real height is measured
    ghost.replaceWith(node);
    return { id, node, item, sig: itemSignature(item) };
  });
  state.entries.unshift(...restored);
  layoutMasonry();
  if (anchor) {
    const shift = anchor.node.getBoundingClientRect().top - anchorTop;
    if (Math.abs(shift) > 1) {
      window.scrollTo({ top: window.scrollY + shift, behavior: 'instant' });
      glideShiftHook?.(shift); // a running glide-to-top must not mistake this correction for the reader grabbing the page
    }
  }
  scheduleRestore(); // keep going while the blank is still close
}

// An IntersectionObserver only reports *changes*. If the sentinel was already inside the preload zone while a page was
// loading (the callback was ignored then) or stays inside it after the page arrived, no new event ever comes and the
// feed would stop loading. Un/re-observing makes the browser deliver a fresh "is it visible now?" callback.
function rearmSentinel() {
  if (!intersectionObserver || state.ended || state.newsId) return;
  intersectionObserver.unobserve(sentinel);
  intersectionObserver.observe(sentinel);
}

// A search pages through the whole feed in the background. Pages are spaced out so that it never comes close to the
// server's request limit (an unpaced search sent a request the moment the previous page arrived and hit HTTP 429).
const SEARCH_PAGE_GAP = 450;
let lastPageAt = 0;
let paceTimer = 0;

async function loadMore() {
  if (!state.city || state.loading || state.ended) return;
  if (state.searchTokens.length && state.cursor) {
    const wait = lastPageAt + SEARCH_PAGE_GAP - Date.now();
    if (wait > 0) {
      // Let the sentinel decide again when the gap is over (the search may have been closed meanwhile).
      if (!paceTimer) paceTimer = setTimeout(() => { paceTimer = 0; rearmSentinel(); }, wait);
      return;
    }
  }
  state.loading = true;
  lastPageAt = Date.now();
  feed.setAttribute('aria-busy', 'true');
  // While a search pages through the feed in the background no placeholder cards are shown: they flashed on and off
  // with every page and made the page height jump. The search bar shows a progress line instead (applySearchFilter).
  if (!state.cursor || !state.searchTokens.length) showSkeletons(skeletonCount(!state.cursor));
  const params = new URLSearchParams({ city: state.city.id, scope: state.scope, limit: '12', ...feedPreferenceParams(), ...categoryParams() });
  if (state.cursor) params.set('cursor', state.cursor);
  try {
    const data = await getJson(`/api/public/feed?${params}`);
    feed.querySelectorAll('.news-skeleton').forEach((node) => node.remove());
    const isFirstPage = !state.cursor;
    if (isFirstPage) {
      const pinned = Array.isArray(data.pinned) ? data.pinned : [];
      state.pinnedIds = new Set(pinned.map((item) => Number(item.id)));
      state.pinnedSig = pinnedSignature(pinned);
      // The prayer card is waited for (a moment at most) so that it is painted together with the urgent/important cards.
      await Promise.race([prayerReady, new Promise((resolve) => setTimeout(resolve, 600))]);
      pinnedStrip.hidden = !pinned.length;
      if (pinned.length) pinnedStrip.innerHTML = pinned.map(pinnedMarkup).join('');
      openPrayerGate();
    }
    for (const item of data.items) {
      if (state.firstId == null) state.firstId = item.id;
      if (state.pinnedIds.has(Number(item.id))) continue;
      const template = document.createElement('template');
      template.innerHTML = cardMarkup(item, { featured: isFirstPage && state.entries.length === 0 && Boolean(item.cover?.src) });
      const node = template.content.firstElementChild;
      if (state.searchTokens.length && !cardMatchesSearch(node, state.searchTokens)) node.classList.add('is-search-hidden');
      feed.append(node);
      state.entries.push({ id: item.id, node, item, sig: itemSignature(item) });
    }
    state.cursor = data.next_cursor;
    state.ended = !data.next_cursor;
    state.loading = false;
    feed.setAttribute('aria-busy', 'false');
    if (state.entries.length || pinnedStrip.querySelector('[data-news-id], .prayer-card')) {
      feedMessage.textContent = state.ended ? 'همین بود؛ خبر تازه‌ای برای نمایش نیست.' : '';
    } else {
      feed.innerHTML = emptyFeedMarkup();
      feedMessage.textContent = '';
    }
    layoutMasonry();
    recycleFeed();
    scheduleSearchFilter();
    if (state.ended) intersectionObserver?.unobserve(sentinel);
    else rearmSentinel();
    // First page painted (possibly from cache): once the screen is filled, check the server for anything newer.
    if (isFirstPage) { queueFreshCheck(); finishLoading(); }
    else maybeRunFreshCheck();
  } catch (error) {
    feed.querySelectorAll('.news-skeleton').forEach((node) => node.remove());
    state.loading = false;
    feed.setAttribute('aria-busy', 'false');
    // "Too many requests" is not an error the reader can do anything about: while searching it is silent (the progress
    // line keeps running) and the page is requested again after the time the server asked for.
    const throttled = error.status === 429;
    feedMessage.textContent = throttled && state.searchTokens.length ? '' : (error.message || 'بارگذاری خبرها ناموفق بود.');
    // Transient failure (weak connection): try again by itself instead of leaving the feed stuck.
    clearTimeout(loadRetryTimer);
    const retryDelay = throttled ? Math.min(30, Math.max(2, error.retryAfter || 5)) * 1000 : 4000;
    loadRetryTimer = setTimeout(() => { if (!state.loading && !state.ended && state.city && !state.newsId) rearmSentinel(); }, retryDelay);
    skipNextFreshCheck = false;
    maybeRunFreshCheck();
    finishLoading(); // the error message is on screen: nothing more to wait for
  }
}

// ---------- Quick search ----------
// The search button in the header opens a bar under it. Typing hides every card whose title and summary do not contain
// all the typed words (the pinned strip is filtered the same way). Nothing is sent to the server: it works on the
// cards the page already holds. The full text of an article is not part of the feed, so it is deliberately not searched.
// While a query is active the feed keeps loading pages by itself as long as the screen is not full of matches, so a
// match further back in time is found without scrolling through hidden cards.
let searchOpen = false;
let searchTimer = 0;
let searchFrame = 0;

function cardMatchesSearch(node, tokens) {
  const summary = node.querySelector('.card-summary')?.textContent ?? node.dataset.searchSummary ?? '';
  return matchesQuery(tokens, node.getAttribute('aria-label'), summary);
}

function scheduleSearchFilter() {
  if (searchFrame || (!state.searchTokens.length && !document.documentElement.classList.contains('is-searching'))) return;
  searchFrame = requestAnimationFrame(applySearchFilter);
}

function applySearchFilter() {
  searchFrame = 0;
  const tokens = state.searchTokens;
  const searching = tokens.length > 0;
  const root = document.documentElement;
  let shown = 0;
  let pinnedShown = 0;
  for (const node of feed.children) {
    if (!node.matches('article.news-card')) continue;
    const match = cardMatchesSearch(node, tokens);
    node.classList.toggle('is-search-hidden', !match);
    if (match) shown += 1;
  }
  for (const node of pinnedStrip.children) {
    if (!node.matches('article.pinned-card')) continue;
    const match = cardMatchesSearch(node, tokens);
    node.classList.toggle('is-search-hidden', !match);
    if (match) pinnedShown += 1;
  }
  const total = shown + pinnedShown;
  // "Settled" = nothing more will be loaded, so the count is final and an empty result really is empty.
  const settled = state.ended && !state.loading;
  const none = searching && total === 0 && settled;
  root.classList.toggle('is-searching', searching);
  quickSearch.classList.toggle('is-loading', searching && !settled);
  root.classList.toggle('search-no-results', none);
  pinnedWrap.classList.toggle('is-search-empty', searching && pinnedShown === 0);
  searchEmpty.hidden = !none;
  quickSearchCount.textContent = !searching ? ''
    : total === 0 && !settled ? 'در حال جست‌وجو…'
      : settled ? `${digits.format(total)} نتیجه` : `${digits.format(total)} نتیجه تا اینجا`;
  layoutMasonry();
  requestAnimationFrame(() => updatePinnedNav());
}

// Cards recycled off the top are only data and an empty ghost; a search needs all of them back as real cards.
function restoreAllRecycled() {
  if (!state.recycled.length) return;
  const restored = state.recycled.splice(0).map(({ id, item, featured, ghost }) => {
    const node = createCardNode(item, featured);
    ghost.replaceWith(node);
    return { id, node, item, sig: itemSignature(item) };
  });
  state.entries.unshift(...restored);
}

function commitSearch() {
  clearTimeout(searchTimer);
  const tokens = parseQuery(quickSearchInput.value);
  if (tokens.join(' ') === state.searchTokens.join(' ')) return;
  const wasSearching = state.searchTokens.length > 0;
  state.searchTokens = tokens;
  if (tokens.length && !wasSearching) restoreAllRecycled();
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  applySearchFilter();
  rearmSentinel(); // hidden cards may have left room on the screen: let the feed load more if it is needed
}

function syncSearchVisibility() {
  searchButton.hidden = app.hidden; // no search inside an article
  quickSearch.hidden = app.hidden || !searchOpen;
}

function setSearchOpen(open) {
  searchOpen = open;
  searchButton.setAttribute('aria-expanded', String(open));
  if (!open) quickSearchInput.value = '';
  syncSearchVisibility();
  if (open) quickSearchInput.focus({ preventScroll: true });
  else commitSearch();
}

searchButton.addEventListener('click', () => setSearchOpen(!searchOpen));
quickSearchClose.addEventListener('click', () => {
  setSearchOpen(false);
  searchButton.focus({ preventScroll: true });
});
quickSearchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(commitSearch, 140);
});
quickSearchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    commitSearch();
    quickSearchInput.blur(); // closes the phone keyboard so the results are visible
  } else if (event.key === 'Escape') {
    event.preventDefault();
    quickSearchClose.click();
  }
});
// Cards that arrive while a query is active (next pages, live updates, a rebuilt feed) are filtered too.
new MutationObserver(scheduleSearchFilter).observe(feed, { childList: true });
new MutationObserver(scheduleSearchFilter).observe(pinnedStrip, { childList: true });
new MutationObserver(syncSearchVisibility).observe(app, { attributes: true, attributeFilter: ['hidden'] });
syncSearchVisibility();

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
// Freshness check: the first page may have been painted from the service worker's cache, so once the page is on
// screen the reader asks the server one more time for the newest first page (see queueFreshCheck below).
let freshPending = false;
let skipNextFreshCheck = false;
let lastFeedSyncAt = 0;

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

// ---------- Next astronomical / religious event: first card of the strip, only when the visitor shares the position ----------
// The module is loaded after the first paint; without it (or without permission) nothing here shows.
let prayerNode = null;
let prayerView = null;
let prayerModule = null;
let prayerGate = false; // closed until the strip has been built once, so the card never shows up before / apart from the news cards
function syncPrayerCard() {
  if (!prayerGate) return;
  const showAccount = !accountButton.hidden;
  if (!prayerView) {
    prayerNode?.remove();
  } else {
    if (!prayerNode) {
      prayerNode = document.createElement('article');
      prayerNode.className = 'prayer-card';
      prayerNode.setAttribute('role', 'group');
      prayerNode.setAttribute('aria-label', 'رویداد نجومی و شرعی بعدی');
    }
    prayerNode.innerHTML = prayerModule.prayerMarkup(prayerView);
    if (pinnedStrip.children[showAccount ? 1 : 0] !== prayerNode) pinnedStrip.prepend(prayerNode);
  }
  // The account card always comes first, before the prayer card and the news cards.
  if (!showAccount) accountButton.remove();
  else if (pinnedStrip.firstElementChild !== accountButton) pinnedStrip.prepend(accountButton);
  pinnedStrip.hidden = !(showAccount || prayerView || pinnedStrip.querySelector('[data-news-id]'));
  updatePinnedNav();
}
function openPrayerGate() {
  prayerGate = true;
  syncPrayerCard();
}
setTimeout(openPrayerGate, 4000); // a failed feed must not keep the card away

// A visitor who allowed the position before has it remembered: the module is then loaded at once, in parallel with the
// feed, and the card is ready for the first strip render. Without a remembered position (first visit) the question is
// asked a moment after the first paint instead.
let prayerCard = null;
function loadPrayerCard() {
  prayerCard ??= import('/shared/prayer-card.v0.1.146.js').then((module) => {
    prayerModule = module;
    return module.createPrayerCard({ onChange: (view) => { prayerView = view; syncPrayerCard(); } });
  });
  return prayerCard;
}
const prayerPositionRemembered = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem('pnu.geo.pos'));
    return Boolean(saved && Number.isFinite(saved.lat) && Number.isFinite(saved.lon) && Date.now() - saved.at <= 7 * 864e5);
  } catch { return false; }
})();
const prayerReady = prayerPositionRemembered
  ? loadPrayerCard().then((card) => card.showRemembered()).catch(() => false) // offline or an old browser: no card, nothing else changes
  : Promise.resolve(false);
setTimeout(() => loadPrayerCard().then((card) => card.start()).catch(() => {}), prayerPositionRemembered ? 0 : 1200);

function renderPinnedStrip(pinned) {
  pinnedStrip.hidden = !pinned.length;
  pinnedStrip.innerHTML = pinned.length ? pinned.map(pinnedMarkup).join('') : '';
  syncPrayerCard();
  if (pinned.length && !reducedMotion.matches) pinnedStrip.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 450, easing: 'ease-out' });
}

async function applyLiveData(data, { compensate = false } = {}) {
  const plan = planLiveUpdate(state.entries, data);
  const nextPinnedSig = pinnedSignature(plan.pinned);
  const pinnedChanged = nextPinnedSig !== state.pinnedSig;
  const firstId = plan.items[0]?.id ?? null;

  if (!state.entries.length) {
    // Empty state (or nothing loaded yet): simply load the feed normally when something showed up.
    if (plan.items.length || plan.pinned.length) rebuildFromFresh();
    return;
  }
  // Cards above the viewport were recycled (ghosts stand in for them): rebuilding from the top is the safe way.
  if (plan.resync || (state.recycled.length && (plan.inserts.length || plan.removed.length))) { rebuildFromFresh(); return; }
  if (!plan.inserts.length && !plan.updates.length && !plan.removed.length && !pinnedChanged) {
    state.firstId = firstId ?? state.firstId;
    return;
  }

  // 1) Cards that disappeared fade out first.
  const removedNodes = state.entries.filter((entry) => plan.removed.includes(Number(entry.id))).map((entry) => entry.node);
  if (removedNodes.length) await Promise.all(removedNodes.map(animateOut));
  if (!state.city || state.newsId || state.loading) { liveDirty = true; return; }

  // 2) Change the DOM in one go, then let the grid glide to its new layout.
  // compensate: the reader is further down the page and about to be scrolled up; keep what they see exactly where it is.
  const anchorEntry = compensate ? state.entries.find((entry) => entry.node.getBoundingClientRect().bottom > 0) : null;
  const anchorTop = anchorEntry ? anchorEntry.node.getBoundingClientRect().top : 0;
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
  if (!state.entries.length && !pinnedStrip.querySelector('[data-news-id], .prayer-card')) {
    feed.innerHTML = emptyFeedMarkup();
  }
  layoutMasonry();
  if (compensate) {
    if (anchorEntry?.node.isConnected) {
      const shift = anchorEntry.node.getBoundingClientRect().top - anchorTop;
      if (Math.abs(shift) >= 1) {
        const root = document.documentElement;
        const previous = root.style.scrollBehavior;
        root.style.scrollBehavior = 'auto';
        window.scrollBy(0, shift);
        root.style.scrollBehavior = previous;
      }
    }
    for (const node of fresh) { node.classList.add('is-fresh'); setTimeout(() => node.classList.remove('is-fresh'), 2600); }
    return;
  }
  playFlip(before, skip);
  for (const node of fresh) animateIn(node);
}

// A rebuild that was caused by fresh server data (the service worker stores it as the new cached first page) does not
// need another freshness check afterwards.
function rebuildFromFresh() {
  skipNextFreshCheck = true;
  resetFeed();
}

// Resolves once the page has had time to finish painting: the load event (but never waiting longer than a moment
// on a slow connection) plus two animation frames.
function pageSettled() {
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    };
    if (document.readyState === 'complete') { finish(); return; }
    setTimeout(finish, 2500);
    addEventListener('load', finish, { once: true });
  });
}

function queueFreshCheck() {
  if (skipNextFreshCheck) { skipNextFreshCheck = false; return; }
  freshPending = true;
  maybeRunFreshCheck();
}

function maybeRunFreshCheck() {
  if (!freshPending || state.loading || !state.city || state.newsId) return;
  freshPending = false;
  pageSettled().then(() => {
    // The screen needed another page in the meantime: loadMore calls this again when it is done.
    if (state.loading) { freshPending = true; return; }
    syncFeed();
  });
}

// Coming back to the page (phone unlocked, app switched back, back/forward cache, network returned): the live
// channel may have been cut while the page was away and missed events, so check again when the last look is old.
const RESUME_STALE_MS = 20_000;
function startFreshnessWatch() {
  const check = () => {
    // liveDirty: the live channel's own visibility handler is already syncing.
    if (document.hidden || liveSyncing || liveDirty || !state.city || state.newsId) return;
    if (Date.now() - lastFeedSyncAt < RESUME_STALE_MS) return;
    syncFeed();
  };
  document.addEventListener('visibilitychange', check);
  addEventListener('pageshow', (event) => { if (event.persisted) check(); });
  addEventListener('online', check);
}

async function syncFeed() {
  refreshCategories();
  if (!state.city || state.newsId || state.loading || liveSyncing || bannerScrolling || document.hidden) { liveDirty = true; return; }
  const cityId = String(state.city.id);
  const categoryId = state.category;
  liveSyncing = true;
  liveDirty = false;
  try {
    const params = new URLSearchParams({ city: cityId, scope: state.scope, limit: '12', ...feedPreferenceParams(), ...categoryParams(), live: String(Date.now()) });
    const data = await getJson(`/api/public/feed?${params}`);
    lastFeedSyncAt = Date.now();
    if (!state.city || String(state.city.id) !== cityId || state.category !== categoryId || state.newsId || state.loading) { liveDirty = true; return; }
    if (window.scrollY > LIVE_NEAR_TOP) {
      // The reader is down the page: never move the content under their finger; just offer the banner.
      // Cards recycled off the top of a long feed are still known to the reader: without them the newest cards would
      // look "new" to the comparison and the banner would appear although nothing was published.
      const known = state.recycled.length
        ? [...state.recycled.map(({ id, item }) => ({ id, item, sig: itemSignature(item) })), ...state.entries]
        : state.entries;
      const plan = planLiveUpdate(known, data);
      if (known.length && (plan.inserts.length || plan.resync)) newItemsBanner.hidden = false;
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
    syncAccountUi();
    const currentNewsTitle = state.newsId ? document.querySelector('#news-view h1')?.textContent : null;
    document.title = currentNewsTitle ? `${currentNewsTitle} — ${nextConfig.site_title || 'اخبار پیام‌نور'}` : nextConfig.site_title || 'اخبار پیام‌نور';
    document.getElementById('site-title').textContent = nextConfig.site_title || 'اخبار پیام‌نور';
    const selected = state.city ? findCity(state.city.id) : null;
    // An empty list means the server is not ready yet (restart, deploy), not that every center vanished.
    const listReady = Array.isArray(nextConfig.provinces) && nextConfig.provinces.length > 0;
    if (state.city && !selected && listReady) {
      state.city = null;
      state.province = null;
      // the saved choice stays in the browser: if the center becomes visible again it is picked up on the next visit
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
  state.newsOnly = newsOnly;
  initTheme();
  initFontScale();
  intersectionObserver = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) loadMore();
  }, { rootMargin: '2200px 0px' }); // a fast fling outruns a short preload zone and shows an empty, dark page
  intersectionObserver.observe(sentinel);
  window.addEventListener('scroll', scheduleRestore, { passive: true });
  try {
    const config = await getJson('/api/public/config');
    state.config = config;
    syncAccountUi();
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
        // The saved center is kept even when it is not in the list now: the list can be empty for a moment while the
        // server restarts after an update, and erasing the choice would send every reader back to the picker for good.
        // Picking a center overwrites it (setCity).
        updateSelectedCity();
        resetFeed();
        if (savedCityId && !config.provinces?.length) feedMessage.textContent = 'فهرست مراکز دانشگاهی هنوز آماده نیست؛ چند لحظهٔ دیگر صفحه را دوباره بارگذاری کنید.';
        else openPicker();
        finishLoading(); // no center chosen yet: the picker (or the message) is the first screen
      }
    }
    dock.renderRadio(config.radio);
    if (!newsOnly) maybeAutoplayRadio();
  } catch {
    feedMessage.textContent = 'ارتباط با سرور برقرار نشد. صفحه را دوباره بارگذاری کنید.';
    finishLoading();
  }
  state.refreshTimer = setInterval(refreshConfig, 15_000);
  setInterval(syncFeed, 60_000);
  if (!newsOnly) { startLive(); startFreshnessWatch(); }
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
    const unsave = bookmarks.has(id) ? `<button type="button" class="share-button" data-unsave-missing="${Number(id)}">حذف از خبرهای ذخیره‌شده</button>` : '';
    // No connection is not «news not found»: the heading says what happened.
    target.innerHTML = `<section class="reader-error"><h1>${error.network ? 'ارتباط برقرار نشد' : 'خبر پیدا نشد'}</h1><p>${escapeHtml(error.message)}</p><div class="news-actions">${unsave}<a class="news-back" href="/">بازگشت به خبرها</a></div></section>`;
    target.hidden = false;
  } finally {
    if (initial) finishLoading();
  }
}

let galleryImages = [];
let currentNewsItem = null;

// Every link to another address inside the article text (the portal's «full text» link included) opens in a new tab,
// so the article stays open behind it and the browser's back button never has to rebuild the reader. The stored
// bodies of older news carry no target (or none for the portal link), so it is set here whatever the stored form is.
function newTabLinks(html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  for (const link of template.content.querySelectorAll('a[href]')) {
    if (!/^https?:\/\//i.test(link.getAttribute('href') ?? '')) continue;
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer nofollow');
  }
  return template.innerHTML;
}

function pageSaveMarkup(item) {
  const saved = bookmarks.has(item.id);
  return `<button type="button" class="share-button save-button${saved ? ' is-saved' : ''}" data-save-page aria-pressed="${saved}"><svg class="icon" aria-hidden="true"><use href="#icon-bookmark"/></svg><span>${saved ? 'ذخیره‌شده' : 'ذخیرهٔ خبر'}</span></button>`;
}

function renderNewsPage(item, initial) {
  currentNewsItem = item;
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
    <article class="news-page" data-news-page-id="${item.id}">${cover}<h1>${escapeHtml(item.title)}</h1>
    <div class="news-details">${category}<time datetime="${escapeHtml(item.published_at)}">${fullDate}</time><span>${digits.format(item.view_count)} بازدید</span></div>
    <div class="news-body">${newTabLinks(item.body_html)}</div>
    ${signature}
    ${gallery ? `<section class="news-gallery" aria-label="تصاویر خبر">${gallery}</section>` : ''}
    ${files ? `<section class="attachment-list"><h2>پیوست‌ها</h2>${files}</section>` : ''}
    <div class="news-actions">${pageSaveMarkup(item)}<button type="button" class="share-button" data-share><svg class="icon"><use href="${SHARE_ICON}"/></svg>اشتراک‌گذاری خبر</button></div>
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

// ---------- Saved news ----------
const savedDialog = document.getElementById('saved-dialog');
const savedList = document.getElementById('saved-list');
const savedSub = document.getElementById('saved-sub');
const savedButton = document.getElementById('saved-button');
const savedCount = document.getElementById('saved-count');
const savedLogin = document.getElementById('saved-login');

// The card node of the feed is the only thing a click gives us; the news item it was built from is kept in state.entries.
function itemForCard(card) {
  const id = Number(card.dataset.newsId);
  const entry = state.entries.find((candidate) => Number(candidate.id) === id);
  return entry?.item ?? pinnedItems.get(id) ?? { id, title: card.getAttribute('aria-label') ?? '' };
}

function toggleSaved(item, button) {
  const result = bookmarks.toggle(item.id, snapFromItem(item));
  if (!result.ok) {
    showToast(result.reason === 'limit'
      ? `حداکثر ${digits.format(MAX_BOOKMARKS)} خبر را می‌توان ذخیره کرد؛ ابتدا چند مورد را حذف کنید.`
      : 'ذخیرهٔ خبر ممکن نشد.');
    return;
  }
  if (!result.saved) showToast('از خبرهای ذخیره‌شده حذف شد');
  else showToast(bookmarks.persistent ? 'خبر ذخیره شد' : 'مرورگر اجازهٔ ذخیره‌سازی نمی‌دهد؛ نشانک‌ها فقط تا بستن صفحه می‌مانند.');
  if (result.saved && button) {
    button.classList.remove('is-popping');
    void button.offsetWidth; // restart the animation
    button.classList.add('is-popping');
    button.addEventListener('animationend', () => button.classList.remove('is-popping'), { once: true });
  }
}

function setSaveState(button, saved) {
  button.classList.toggle('is-saved', saved);
  button.setAttribute('aria-pressed', String(saved));
  if (button.matches('[data-save-card]')) button.title = saved ? 'حذف از خبرهای ذخیره‌شده' : 'ذخیرهٔ خبر';
  else {
    const label = button.querySelector('span');
    if (label) label.textContent = saved ? 'ذخیره‌شده' : 'ذخیرهٔ خبر';
  }
}

function savedItemMarkup(record) {
  const snap = record.snap ?? {};
  const title = snap.title || snap.summary || 'خبر ذخیره‌شده';
  const text = snap.summary || title; // the summary is what the list shows; news saved before the summary was kept show their title
  // No inline style here: the page's content-security-policy does not allow style attributes, so a news without a picture shows the
  // coloured placeholder image, like the cards do.
  const image = snap.cover
    ? `<img referrerpolicy="no-referrer" src="${escapeHtml(snap.cover)}" width="64" height="64" loading="lazy" decoding="async" alt="">`
    : placeholderMarkup(snap.color, 'saved-placeholder');
  const when = snap.publishedAt ? `<time datetime="${escapeHtml(snap.publishedAt)}">${relativeDate(snap.publishedAt)}</time>` : '';
  const unit = snap.unit ? `<span>${escapeHtml(snap.unit)}</span>` : '';
  return `<li class="saved-item" data-saved-id="${record.id}">
    <button type="button" class="saved-open" data-saved-open><span class="saved-thumb">${image}</span><span class="saved-text"><strong>${escapeHtml(text)}</strong><small>${unit}${when}</small></span></button>
    <button type="button" class="saved-remove" data-saved-remove aria-label="${escapeHtml(`حذف «${title}» از خبرهای ذخیره‌شده`)}" title="حذف از خبرهای ذخیره‌شده"><svg class="icon" aria-hidden="true"><use href="#icon-close"/></svg></button>
  </li>`;
}

function renderSaved() {
  const records = bookmarks.list();
  const accountsOn = state.config?.reader?.signup_enabled === true;
  const where = readerUser ? 'با حساب شما در همهٔ دستگاه‌ها همگام می‌شود.' : 'فقط روی همین دستگاه نگهداری می‌شود.';
  if (!bookmarks.persistent) savedSub.textContent = 'مرورگر اجازهٔ ذخیره‌سازی نمی‌دهد؛ نشانک‌ها فقط تا بستن صفحه می‌مانند.';
  else savedSub.textContent = records.length ? `${digits.format(records.length)} خبر؛ ${where}` : where;
  // Signed out while accounts are on: one quiet line that explains what signing in gives.
  savedLogin.hidden = !(accountsOn && !readerUser);
  savedList.innerHTML = records.length
    ? records.map(savedItemMarkup).join('')
    : '<li class="saved-empty"><svg class="icon" aria-hidden="true"><use href="#icon-bookmark"/></svg><p>هنوز خبری ذخیره نکرده‌اید.</p><p>روی نشانک هر خبر بزنید تا برای بعد اینجا بماند.</p></li>';
}

// Redraws everything that shows the saved state: card buttons, the news page button, the header badge and (when open) the list.
function syncSavedUi() {
  for (const button of document.querySelectorAll('[data-save-card]')) {
    const id = Number(button.closest('[data-news-id]')?.dataset.newsId);
    setSaveState(button, bookmarks.has(id));
  }
  const pageButton = document.querySelector('[data-save-page]');
  if (pageButton && currentNewsItem) setSaveState(pageButton, bookmarks.has(currentNewsItem.id));
  const count = bookmarks.count();
  savedCount.hidden = count === 0;
  savedCount.textContent = digits.format(count);
  savedButton.setAttribute('aria-label', count ? `خبرهای ذخیره‌شده، ${digits.format(count)} مورد` : 'خبرهای ذخیره‌شده');
  if (savedDialog.open) renderSaved();
}

savedButton.addEventListener('click', () => {
  renderSaved();
  savedDialog.showModal();
  hydrateSavedSnapshots();
  bookmarkSync?.then((controller) => controller.syncNow()).catch(() => {}); // what is on screen is as fresh as it can be
});
savedLogin.addEventListener('click', () => {
  savedDialog.close();
  accountButton.click();
});
savedDialog.addEventListener('click', (event) => {
  const row = event.target.closest('[data-saved-id]');
  if (row && event.target.closest('[data-saved-remove]')) {
    bookmarks.remove(row.dataset.savedId);
    return;
  }
  if (row && event.target.closest('[data-saved-open]')) {
    const record = bookmarks.list().find((candidate) => String(candidate.id) === row.dataset.savedId);
    savedDialog.close();
    if (record) openSavedNews(record);
    return;
  }
  if (event.target === savedDialog || event.target.closest('[data-dialog-close]')) savedDialog.close();
});

// Opens a saved news the way its card would: the original article in a new tab for portal news, this site's page for the rest.
// The address is used from the local copy when that has it whole. When it does not (a bookmark from an older version whose
// address was cut, an address too long to keep, or a kind of news not yet known) the server is asked, and the answer is kept so the
// next time needs no question.
async function openSavedNews(record) {
  const snap = record.snap ?? {};
  if (snap.sourceUrl) {
    window.open(snap.sourceUrl, '_blank', 'noopener,noreferrer');
    return;
  }
  if (snap.link === 'internal') {
    navigateToNews(record.id);
    return;
  }
  try {
    const { items } = await getJson(`/api/public/news-snapshots?ids=${record.id}`);
    const item = items.find((candidate) => Number(candidate.id) === Number(record.id));
    const address = typeof item?.source_url === 'string' && item.source_url.startsWith('https://') ? item.source_url : '';
    if (item) bookmarks.patchSnap(record.id, { link: address ? 'external' : 'internal', sourceUrl: address || undefined });
    if (address) window.open(address, '_blank', 'noopener,noreferrer');
    else navigateToNews(record.id);
  } catch {
    navigateToNews(record.id); // offline or unknown: this site's page is the safe place to go
  }
}

// Bookmarks that came from another device have no title yet: ask the server for a few lines about each (40 at a time).
// A news the server does not give back (expired, taken down) is not asked for again during this visit.
const unavailableSnapshots = new Set();
let hydratingSnapshots = false;
async function hydrateSavedSnapshots() {
  if (hydratingSnapshots) return;
  hydratingSnapshots = true;
  try {
    for (let round = 0; round < 15; round += 1) {
      const ids = bookmarks.needSnapshots(unavailableSnapshots).slice(0, 40);
      if (!ids.length) break;
      const { items } = await getJson(`/api/public/news-snapshots?ids=${ids.join(',')}`);
      const given = new Set(items.map((item) => Number(item.id)));
      for (const id of ids) if (!given.has(id)) unavailableSnapshots.add(id);
      bookmarks.setSnaps(new Map(items.map((item) => [Number(item.id), snapFromItem(item)])));
    }
  } catch { /* offline: the placeholders stay and the next sync or opening tries again */ } finally {
    hydratingSnapshots = false;
  }
}

bookmarks.subscribe(syncSavedUi);
// Another tab of the reader changed the saved news.
window.addEventListener('storage', (event) => {
  if (event.key === BOOKMARKS_KEY || event.key === null) bookmarks.reload();
});
syncSavedUi();

// ---------- Reader account (login by SMS code) ----------
// The button exists only while the main admin has reader signup switched on (/api/public/config: reader.signup_enabled).
// Everything behind it (the dialog, the steps) is a separate module, loaded on the first tap.
let readerUser = null;
let readerChecked = false;
let accountModule = null;
let bookmarkSync = null; // the sync controller (a promise), alive only while accounts are on and a reader is signed in

function startBookmarkSync() {
  if (bookmarkSync) return;
  bookmarkSync = import('/shared/bookmark-sync.v0.1.146.js').then(({ createBookmarkSync }) => {
    const controller = createBookmarkSync({
      store: bookmarks,
      isActive: () => Boolean(readerUser), // switching signup off stops new logins only, not a signed-in reader's sync
      pull: async () => {
        const response = await fetchOrExplain('/api/reader/bookmarks', { headers: { accept: 'application/json' } });
        let body = null;
        try { body = await response.json(); } catch { body = null; }
        return { status: response.status, body };
      },
      send: async (items) => {
        const response = await fetchOrExplain('/api/reader/bookmarks/sync', {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ items }),
        });
        let body = null;
        try { body = await response.json(); } catch { body = null; }
        return { status: response.status, body };
      },
      onUnauthorized: () => { readerUser = null; syncAccountUi(); },
      onMerged: () => hydrateSavedSnapshots(),
    });
    controller.start();
    return controller;
  });
}

function stopBookmarkSync() {
  const running = bookmarkSync;
  bookmarkSync = null;
  running?.then((controller) => controller.stop()).catch(() => {});
}

// 09123456789 or +989123456789 -> ۰۹۱۲ ۳۴۵ ۶۷۸۹ (for showing only; the module with the full formatter loads on the first tap)
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
function accountPhoneText(phone) {
  const national = String(phone ?? '').replace(/^\+98/, '0');
  const grouped = /^\d{11}$/.test(national) ? `${national.slice(0, 4)} ${national.slice(4, 7)} ${national.slice(7)}` : national;
  return grouped.replace(/\d/g, (digit) => PERSIAN_DIGITS[digit]);
}

function accountUnitName(unitId) {
  for (const province of state.config?.provinces ?? []) {
    const city = province.cities?.find((item) => Number(item.id) === Number(unitId));
    if (city) return city.name;
  }
  return '';
}

// Signed out: only the person icon. Signed in: the same three lines as the prayer card: the phone number, the name, and
// under it the reader's university centre.
function paintAccountCard(user) {
  if (!user) {
    accountButton.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-user"/></svg>';
    return;
  }
  const unit = accountUnitName(user.unit_id);
  accountButton.innerHTML = `<div class="account-line account-phone-line"><bdi dir="ltr">${escapeHtml(accountPhoneText(user.phone))}</bdi></div>`
    + `<div class="account-name">${escapeHtml(`${user.first_name ?? ''} ${user.last_name ?? ''}`.trim())}</div>`
    + (unit ? `<div class="account-unit">${escapeHtml(unit)}</div>` : '');
}

function syncAccountUi() {
  const enabled = state.config?.reader?.signup_enabled === true;
  const signedIn = Boolean(readerUser);
  // Logging in and signing up need an SMS, so they exist only while the main admin has signup on. A reader who is already
  // signed in does not: the card (profile, sign out) and the bookmark sync stay, switch or no switch.
  accountButton.hidden = !(enabled || signedIn);
  accountButton.classList.toggle('is-signed-in', signedIn);
  accountButton.classList.toggle('is-guest', !signedIn);
  const label = signedIn ? `حساب من، ${readerUser.first_name}` : 'ورود یا ثبت‌نام';
  accountButton.setAttribute('aria-label', label);
  accountButton.title = label;
  paintAccountCard(readerUser);
  syncPrayerCard();
  if (signedIn) startBookmarkSync();
  else stopBookmarkSync();
  if (savedDialog.open) renderSaved();
  if (!enabled && !signedIn) accountModule?.then((module) => module.closeAccount()).catch(() => {});
  if (state.config && !readerChecked) { // one quiet question per visit: is this browser already signed in?
    readerChecked = true;
    getJson('/api/reader/me').then(({ user }) => { readerUser = user; syncAccountUi(); }).catch(() => { readerChecked = false; });
  }
}

accountButton.addEventListener('click', async () => {
  accountModule ??= import('/shared/reader-account.v0.1.146.js');
  try {
    const module = await accountModule;
    module.openAccount({
      user: readerUser,
      provinces: state.config?.provinces ?? [],
      defaultUnitId: state.city?.id ?? null,
      authMethod: state.config?.reader?.auth_method === 'sms_receive' ? 'sms_receive' : 'sms_send', // missing or unknown: the original method
      showToast,
      onUser: (user) => { readerUser = user; syncAccountUi(); },
      onDisabled: () => { state.config = { ...state.config, reader: { ...state.config?.reader, signup_enabled: false } }; syncAccountUi(); },
      onMethod: (method) => { state.config = { ...state.config, reader: { ...state.config?.reader, auth_method: method } }; },
    });
  } catch {
    accountModule = null;
    showToast('بارگذاری بخش حساب ممکن نشد؛ اتصال اینترنت را بررسی کنید.');
  }
});

// ---------- Settings and about dialogs ----------
const settingsDialog = document.getElementById('settings-dialog');
const aboutDialog = document.getElementById('about-dialog');

let feedPrefsStale = false;

// Autoplay makes no sense while the radio itself is hidden. When the radio is switched off the row is first
// disabled, then fades out and folds away under the radio item; switching it on reverses that. Opening the dialog
// sets the state at once, without animation.
let autoplayRowTimer = 0;
function syncAutoplaySwitch({ animate = false } = {}) {
  const row = document.getElementById('autoplay-row');
  const input = settingsDialog.querySelector('[data-pref="autoplay"]');
  if (!row || !input) return;
  const off = !prefs.radio;
  clearTimeout(autoplayRowTimer);
  if (!animate) {
    input.disabled = off;
    row.classList.toggle('is-disabled', off);
    row.classList.toggle('is-collapsed', off);
    row.inert = off;
    return;
  }
  if (off) {
    input.disabled = true;
    row.classList.add('is-disabled');
    autoplayRowTimer = setTimeout(() => {
      row.classList.add('is-collapsed');
      row.inert = true;
    }, 350);
  } else {
    row.inert = false;
    row.classList.remove('is-collapsed');
    autoplayRowTimer = setTimeout(() => {
      row.classList.remove('is-disabled');
      input.disabled = false;
    }, 300);
  }
}

function renderSettings() {
  for (const input of settingsDialog.querySelectorAll('[data-pref]')) input.checked = Boolean(prefs[input.dataset.pref]);
  syncAutoplaySwitch();
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
  if (key === 'radio') {
    applyRadioPreference();
    syncAutoplaySwitch({ animate: true });
  } else if (key === 'autoplay') {
    // only matters at the next page load
  } else if (state.city && !state.newsId) resetFeed();
  else feedPrefsStale = true;
});

// ---------- Category dialog ----------
let categorySignature = '';

// Loads the chips for the selected center (counts follow the reader's own region choices) and redraws them.
// A saved category that has no news here any more is dropped and the feed goes back to "all".
let categoriesRequest = 0;
async function refreshCategories() {
  const city = state.city;
  if (!city) {
    state.categories = [];
    categoryButton.hidden = true;
    return;
  }
  const ticket = ++categoriesRequest;
  try {
    const params = new URLSearchParams({ city: city.id, scope: state.scope, ...feedPreferenceParams() });
    const data = await getJson(`/api/public/categories?${params}`);
    if (ticket !== categoriesRequest || !state.city || state.city.id !== city.id) return;
    state.categories = Array.isArray(data.categories) ? data.categories : [];
    const dropped = syncCategories();
    if (dropped && !state.newsId) resetFeed();
  } catch {
    // Offline or a transient error: keep the chips we have; the next refresh tries again.
  }
}

// Draws the button state and the chips; drops a saved choice whose category no longer exists.
// Returns true when the saved choice had to be dropped (the caller then reloads the feed).
function syncCategories({ force = false } = {}) {
  const categories = state.categories;
  let dropped = false;
  if (state.category && !categories.some((item) => Number(item.id) === state.category)) {
    state.category = null;
    dropped = true;
    try { localStorage.removeItem(CATEGORY_KEY); } catch {}
  }
  const chosen = categories.find((item) => Number(item.id) === state.category);
  categoryButton.hidden = !categories.length;
  categoryButton.classList.toggle('is-filtered', Boolean(chosen));
  const label = chosen ? `دسته‌بندی خبرها: ${chosen.name}` : 'دسته‌بندی خبرها';
  categoryButton.title = label;
  categoryButton.setAttribute('aria-label', label);
  const signature = JSON.stringify([categories, state.category]);
  if (force || signature !== categorySignature) {
    categorySignature = signature;
    const chips = [{ id: null, name: 'همه' }, ...categories];
    categoryList.innerHTML = chips.map((item) => `<button type="button" class="category-chip" role="radio" aria-checked="${(item.id ?? null) === (state.category ?? null)}" data-category-id="${item.id ?? ''}"><span class="category-name">${escapeHtml(item.name)}</span>${item.news_count ? `<span class="category-count">${digits.format(item.news_count)}</span>` : ''}</button>`).join('');
  }
  return dropped;
}

categoryButton.addEventListener('click', () => {
  syncCategories({ force: true });
  categoryDialog.showModal();
});
categoryList.addEventListener('click', (event) => {
  const chip = event.target.closest('[data-category-id]');
  if (!chip) return;
  const next = chip.dataset.categoryId ? Number(chip.dataset.categoryId) : null;
  categoryDialog.close();
  if (next === state.category) return;
  state.category = next;
  try {
    if (next) localStorage.setItem(CATEGORY_KEY, String(next));
    else localStorage.removeItem(CATEGORY_KEY);
  } catch {}
  syncCategories();
  newItemsBanner.hidden = true;
  if (state.city && !state.newsId) resetFeed({ scroll: true });
  else feedPrefsStale = true;
});

document.getElementById('about-button').addEventListener('click', () => {
  const version = /app\.v([\d.]+)\.js/.exec(import.meta.url)?.[1] ?? '';
  document.getElementById('about-version').textContent = version.replace(/\d/g, (digit) => '۰۱۲۳۴۵۶۷۸۹'[digit]);
  // Active centers = the centers the reader can pick (centers with an active admin or forced visible).
  const centerCount = (state.config?.provinces ?? []).reduce((sum, province) => sum + province.cities.length, 0);
  document.getElementById('about-centers').textContent = String(centerCount).replace(/\d/g, (digit) => '۰۱۲۳۴۵۶۷۸۹'[digit]);
  aboutDialog.showModal();
  showBuildDate();
});

// The build date (Jalali, Tehran time) is read from /build-info.json the first time the dialog opens; without that file
// (a copy not built by make-deploy-branch.sh) or offline the line just stays hidden.
let buildDateShown = false;
async function showBuildDate() {
  if (buildDateShown) return;
  try {
    const { loadBuildDate } = await import('/shared/build-date.v0.1.146.js');
    const text = await loadBuildDate();
    if (!text) return;
    document.getElementById('about-build').textContent = text;
    document.getElementById('about-build-row').hidden = false;
    buildDateShown = true;
  } catch { /* module or network unavailable: no build line */ }
}

for (const dialog of [settingsDialog, categoryDialog, aboutDialog]) {
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

// `text` (when given) is shared instead of a bare link: a message that carries several links, each with its description.
async function shareNews({ url, title, text }) {
  const copied = text ? 'پیوندهای خبر کپی شد.' : 'پیوند خبر کپی شد.';
  const payload = text ? { title, text } : { title, url };
  try {
    if (navigator.share) await navigator.share(payload);
    else if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text ?? url);
      showToast(copied);
    } else {
      const input = document.createElement('textarea');
      input.value = text ?? url;
      input.setAttribute('readonly', '');
      input.className = 'copy-fallback';
      document.body.append(input);
      input.select();
      document.execCommand('copy');
      input.remove();
      showToast(copied);
    }
  } catch (error) {
    if (error.name !== 'AbortError') showToast('اشتراک‌گذاری انجام نشد.');
  }
}

function shareCurrentNews() {
  return shareNews({ url: location.href, title: document.querySelector('#news-view h1, #app h1')?.textContent || document.title });
}

function shareCard(card) {
  const title = card.getAttribute('aria-label') || document.title;
  const siteUrl = `${location.origin}/n/${card.dataset.newsId}`;
  const portalUrl = card.dataset.sourceUrl;
  // Portal-feed news has two addresses: the original article on the university portal and the page on this site.
  if (portalUrl && portalUrl.startsWith('https://')) {
    return shareNews({
      title,
      text: `${title}\n\nمتن کامل خبر در پورتال دانشگاه:\n${portalUrl}\n\nخواندن همین خبر در سایت اخبار پیام‌نور:\n${siteUrl}`,
    });
  }
  return shareNews({ url: siteUrl, title });
}

function navigateToNews(id) {
  history.replaceState({ ...(history.state ?? {}), readerScrollY: window.scrollY }, '', location.href);
  history.pushState({ readerEntry: true, readerScrollY: window.scrollY }, '', `/n/${id}`);
  loadNewsPage(id);
  // Instant, not the page's smooth scrolling: an animated jump while the feed is swapped for the article makes the
  // sticky header and the status-bar cover flicker on phones.
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
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
    window.scrollTo({ top: scrollY, left: 0, behavior: 'instant' });
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
  const saveButton = event.target.closest('[data-save-card]');
  if (saveButton) {
    event.stopPropagation();
    const savedCard = saveButton.closest('[data-news-id]');
    if (savedCard) toggleSaved(itemForCard(savedCard), saveButton);
    return;
  }
  const shareButton = event.target.closest('[data-share-card]');
  if (shareButton) {
    event.stopPropagation();
    const sharedCard = shareButton.closest('[data-news-id]');
    if (sharedCard) shareCard(sharedCard);
    return;
  }
  const card = event.target.closest('[data-news-id]');
  if (card) openCard(card);
});
// The strip scrolls sideways, but scrollbars are hidden app-wide and a mouse wheel only scrolls up and down, so on a
// desktop it could not be moved at all. Arrow buttons (shown for a mouse only, see the CSS) and the wheel fix that;
// a touch screen keeps swiping. With a mouse, resting the pointer on an arrow keeps the strip moving that way until
// the pointer leaves or the end is reached, so no click is needed; a click (or Enter/Space) still moves it a step for
// the keyboard and for people who prefer reduced motion. scrollLeft is negative in right-to-left pages, hence the
// absolute values.
const pinnedPrev = document.querySelector('.pinned-prev');
const pinnedNext = document.querySelector('.pinned-next');
const pinnedDirection = () => (getComputedStyle(pinnedStrip).direction === 'rtl' ? -1 : 1);
const pinnedRange = () => ({ max: pinnedStrip.scrollWidth - pinnedStrip.clientWidth, position: Math.abs(pinnedStrip.scrollLeft) });
function updatePinnedNav() {
  const { max, position } = pinnedRange();
  const overflowing = !pinnedStrip.hidden && max > 2;
  pinnedPrev.hidden = !overflowing || position <= 2;
  pinnedNext.hidden = !overflowing || position >= max - 2;
  // an arrow that disappears (end reached, strip emptied) ends the hover scrolling it started
  if ((hoverStep < 0 && pinnedPrev.hidden) || (hoverStep > 0 && pinnedNext.hidden)) stopHoverScroll();
}
function scrollPinned(step) {
  pinnedStrip.scrollBy({ left: step * pinnedDirection() * Math.max(pinnedStrip.clientWidth * 0.8, 200), behavior: reducedMotion.matches ? 'auto' : 'smooth' });
}
// Hover scrolling: about 600 px per second after a short ease-in, driven by the frame clock so it is the same speed
// on every screen. It runs only while the pointer is on the arrow.
const HOVER_SPEED = 0.6;
const HOVER_EASE_MS = 250;
let hoverStep = 0;
let hoverFrame = 0;
let hoverStart = 0;
let hoverLast = 0;
const hoverScrolls = () => !reducedMotion.matches;
function hoverTick(now) {
  const elapsed = now - hoverStart;
  const dt = Math.min(now - hoverLast, 50);
  hoverLast = now;
  const ease = Math.min(1, elapsed / HOVER_EASE_MS);
  pinnedStrip.scrollLeft += hoverStep * pinnedDirection() * HOVER_SPEED * ease * dt;
  updatePinnedNav();
  if (!hoverStep) return;
  const { max, position } = pinnedRange();
  if (hoverStep > 0 ? position >= max - 1 : position <= 1) { stopHoverScroll(); return; }
  hoverFrame = requestAnimationFrame(hoverTick);
}
function startHoverScroll(step) {
  if (!hoverScrolls() || hoverStep === step) return;
  cancelAnimationFrame(hoverFrame);
  hoverStep = step;
  hoverStart = hoverLast = performance.now();
  hoverFrame = requestAnimationFrame(hoverTick);
}
function stopHoverScroll() {
  hoverStep = 0;
  cancelAnimationFrame(hoverFrame);
}
for (const [button, step] of [[pinnedPrev, -1], [pinnedNext, 1]]) {
  button.addEventListener('pointerenter', (event) => { if (event.pointerType !== 'touch') startHoverScroll(step); });
  button.addEventListener('pointerleave', stopHoverScroll);
  button.addEventListener('pointercancel', stopHoverScroll);
  // A mouse click is not needed (hovering already scrolls, and a step would fight it); keyboard activation has
  // detail 0 and, with reduced motion, every click keeps moving a step.
  button.addEventListener('click', (event) => { if (event.detail === 0 || !hoverScrolls()) scrollPinned(step); });
}
addEventListener('blur', stopHoverScroll);
pinnedStrip.addEventListener('scroll', updatePinnedNav, { passive: true });
addEventListener('resize', updatePinnedNav);
new MutationObserver(updatePinnedNav).observe(pinnedStrip, { childList: true, attributes: true, attributeFilter: ['hidden'] });
pinnedStrip.addEventListener('wheel', (event) => {
  if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
  const { max, position } = pinnedRange();
  // at either end (or with nothing to scroll) the wheel keeps scrolling the page
  if (max <= 2 || (event.deltaY > 0 && position >= max - 1) || (event.deltaY < 0 && position <= 1)) return;
  event.preventDefault();
  pinnedStrip.scrollLeft += (event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY) * pinnedDirection();
}, { passive: false });
updatePinnedNav();

pinnedStrip.addEventListener('click', (event) => {
  const saveButton = event.target.closest('[data-save-card]');
  if (saveButton) {
    event.stopPropagation();
    const savedCard = saveButton.closest('[data-news-id]');
    if (savedCard) toggleSaved(itemForCard(savedCard), saveButton);
    return;
  }
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
// Banner tap: glide to the top (slow start, fast middle, slow arrival), then reload the feed from the top.
let bannerScrolling = false;
function glideToTop() {
  const startY = window.scrollY;
  if (startY < 2 || reducedMotion.matches) { window.scrollTo(0, 0); return Promise.resolve(); }
  const duration = Math.min(1500, Math.max(650, 450 + startY * 0.12));
  const SETTLE_MS = 450;
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2);
  return new Promise((resolve) => {
    const root = document.documentElement;
    const previous = root.style.scrollBehavior;
    root.style.scrollBehavior = 'auto';
    let startTime = 0;
    let endTime = 0;
    // Cards rebuilt above the reader (see restoreRecycled) move the page by a few pixels while we glide; the glide
    // follows those corrections.
    let offset = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      glideShiftHook = null;
      root.style.scrollBehavior = previous;
      removeEventListener('wheel', onWheel);
      removeEventListener('touchstart', finish);
      removeEventListener('keydown', finish);
      resolve();
    };
    // Mac trackpads (and free-spinning wheels) keep sending momentum wheel events for a second or more after the
    // fingers lifted. They would push the page back down against the glide, and after it ends. So downward wheel
    // events are swallowed while the glide runs and briefly after it; a touch or a key press still cancels it.
    const onWheel = (event) => { if (event.deltaY > 0) event.preventDefault(); };
    glideShiftHook = (shift) => { offset += shift; };
    addEventListener('wheel', onWheel, { passive: false });
    addEventListener('touchstart', finish, { passive: true });
    addEventListener('keydown', finish);
    const step = (now) => {
      if (done) return;
      if (!startTime) startTime = now;
      if (endTime) {
        // Settling: hold the top until the momentum has died down.
        if (window.scrollY > 0) window.scrollTo(0, 0);
        if (now - endTime >= SETTLE_MS) finish(); else requestAnimationFrame(step);
        return;
      }
      const t = Math.min(1, (now - startTime) / duration);
      const y = Math.max(0, Math.round(startY * (1 - ease(t)) + offset * (1 - t)));
      window.scrollTo(0, y);
      if (t < 1) { requestAnimationFrame(step); return; }
      window.scrollTo(0, 0);
      endTime = now;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}
newItemsBanner.addEventListener('click', async () => {
  if (bannerScrolling) return;
  bannerScrolling = true;
  newItemsBanner.hidden = true;
  let handled = false;
  try {
    // 1) Add the new cards right now, above the reader's current position, without moving what they see.
    if (state.city && !state.newsId && !state.loading) {
      try {
        const cityId = String(state.city.id);
        const categoryId = state.category;
        const params = new URLSearchParams({ city: cityId, scope: state.scope, limit: '12', ...feedPreferenceParams(), ...categoryParams(), live: String(Date.now()) });
        const data = await getJson(`/api/public/feed?${params}`);
        const plan = planLiveUpdate(state.entries, data);
        const simple = state.city && String(state.city.id) === cityId && state.category === categoryId
          && !plan.resync && !(state.recycled.length && (plan.inserts.length || plan.removed.length));
        if (simple) {
          await applyLiveData(data, { compensate: true });
          handled = true;
        }
      } catch {
        // Offline or a transient error: fall back to reloading after the scroll.
      }
    }
    // 2) Then glide to the top (slow start, fast middle, slow arrival).
    await glideToTop();
  } finally { bannerScrolling = false; }
  if (!handled) resetFeed();
  else { liveDirty = false; rearmSentinel(); }
});

function handleNewsPageClick(event) {
  if (event.target.closest('[data-share]')) shareCurrentNews();
  const savePage = event.target.closest('[data-save-page]');
  if (savePage && currentNewsItem) toggleSaved(currentNewsItem, savePage);
  const unsave = event.target.closest('[data-unsave-missing]');
  if (unsave) {
    bookmarks.remove(unsave.dataset.unsaveMissing);
    showToast('از خبرهای ذخیره‌شده حذف شد');
    unsave.remove();
  }
}
app.addEventListener('click', handleNewsPageClick);
newsView.addEventListener('click', (event) => {
  handleNewsPageClick(event);
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

// Page title bar: big and centred at the top, small and pinned to the start once the page scrolls.
function initTitleBar() {
  const bar = document.getElementById('feed-title-bar');
  const header = document.querySelector('.site-header');
  if (!bar) return;
  if (header) {
    const syncHeaderHeight = () => document.documentElement.style.setProperty('--header-h', `${header.offsetHeight}px`);
    syncHeaderHeight();
    if ('ResizeObserver' in window) new ResizeObserver(syncHeaderHeight).observe(header);
    else window.addEventListener('resize', syncHeaderHeight);
  }
  let frame = 0;
  const update = () => {
    frame = 0;
    const y = window.scrollY;
    // small hysteresis so the title does not flicker around the threshold
    if (y > 48) bar.classList.add('is-compact');
    else if (y < 16) bar.classList.remove('is-compact');
  };
  window.addEventListener('scroll', () => { if (!frame) frame = requestAnimationFrame(update); }, { passive: true });
  update();
}
initTitleBar();

// Scroll-to-top arrow: only on the home feed, once the reader has scrolled a good way down. It glides back to the top
// the same way the "new items" banner does (instant when the system asks for reduced motion).
function initScrollTop() {
  const button = document.getElementById('scroll-top');
  if (!button) return;
  const SHOW_AFTER = 480;
  let frame = 0;
  const update = () => {
    frame = 0;
    button.hidden = app.hidden || window.scrollY < SHOW_AFTER;
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
  window.addEventListener('scroll', schedule, { passive: true });
  new MutationObserver(schedule).observe(app, { attributes: true, attributeFilter: ['hidden'] });
  button.addEventListener('click', () => { glideToTop(); });
  update();
}
initScrollTop();

// ---------- Inline editing for signed-in staff (WordPress style) ----------
// A visitor without a session costs one tiny request; for a signed-in user the editor module is loaded on demand and
// puts an "edit" button on the news they may edit (the server decides, with the same rule as the panel).
let inlineEdit = null;
let inlineViewerId = null;
let inlineBusy = false;
let inlineCheckedAt = 0;

function afterInlineSave({ id }) {
  if (state.newsId === Number(id)) loadNewsPage(id, { initial: state.newsOnly });
  syncFeed();
}

async function refreshViewer() {
  if (inlineBusy) return;
  inlineBusy = true;
  inlineCheckedAt = Date.now();
  try {
    let user = null;
    try {
      const response = await fetch('/api/auth/viewer', { headers: { accept: 'application/json' } });
      if (!response.ok) return;
      user = (await response.json()).user;
    } catch { return; }
    if (!user) {
      inlineEdit?.disable();
      inlineViewerId = null;
      return;
    }
    if (!inlineEdit) {
      const { initInlineEdit } = await import('/shared/inline-edit.v0.1.146.js');
      inlineEdit = initInlineEdit({ roots: [app, newsView], showToast, onSaved: afterInlineSave });
      inlineEdit.refresh();
    } else if (inlineViewerId !== user.id) {
      inlineEdit.reset();
    }
    inlineViewerId = user.id;
  } finally {
    inlineBusy = false;
  }
}
refreshViewer();
// Signing in or out in the panel's tab: look again when this tab comes back to the front.
document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - inlineCheckedAt > 60_000) refreshViewer(); });
addEventListener('pageshow', (event) => { if (event.persisted) refreshViewer(); });

const initialNewsMatch = /^\/n\/(\d+)$/.exec(location.pathname);
if (initialNewsMatch) {
  // An article opened by its address (a shared link, or the back button returning to it) lifts the loading layer as soon as the article is drawn.
  initializeReader({ newsOnly: true }).then(() => loadNewsPage(initialNewsMatch[1])).finally(finishLoading);
} else {
  initializeReader();
}
