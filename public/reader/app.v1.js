const app = document.getElementById('app');
const newsView = document.getElementById('news-view');
const feed = document.getElementById('feed');
const picker = document.getElementById('city-picker');
const pickerList = document.getElementById('picker-list');
const pickerSearch = document.getElementById('picker-search');
const pickerBack = document.getElementById('picker-back');
const feedMessage = document.getElementById('feed-message');
const sentinel = document.getElementById('feed-sentinel');
const pinnedStrip = document.getElementById('pinned-strip');
const newItemsBanner = document.getElementById('new-items-banner');
const radioRoot = document.getElementById('radio-root');
const state = {
  config: null,
  city: null,
  province: null,
  pickerProvince: null,
  scope: 'all',
  cursor: null,
  loading: false,
  ended: false,
  entries: [],
  spacer: null,
  removedCardCount: 0,
  firstId: null,
  newsId: null,
  refreshTimer: null,
  radioUrl: '',
  radioTitle: '',
  nowPlayingTimer: null,
  toastTimer: null,
  fontScale: 1,
};
let radioAudio = null;
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
    .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک')
    .replace(/[٠-٩۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit) >= 0 ? '۰۱۲۳۴۵۶۷۸۹'.indexOf(digit) : '٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/ـ/g, '').replace(/[\u200c\u200e\u200f]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('is-visible');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2600);
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
    label.textContent = 'انتخاب شهرستان';
    description.textContent = 'برای دیدن خبرهای مرتبط، شهرستان خود را انتخاب کنید.';
    return;
  }
  label.textContent = `${state.city.name} · ${state.province.name}`;
  description.textContent = `خبرهای ${state.city.name} و استان ${state.province.name} در کنار خبرهای کشوری`;
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

function renderPickerList() {
  const query = normalizeSearch(pickerSearch.value);
  const isCities = Boolean(state.pickerProvince);
  pickerBack.hidden = !isCities;
  document.getElementById('picker-title').textContent = isCities ? `شهرستان‌های ${state.pickerProvince.name}` : 'استان را انتخاب کنید';
  pickerSearch.placeholder = isCities ? 'جست‌وجوی شهرستان' : 'جست‌وجوی استان';
  let items;
  if (isCities) {
    items = state.pickerProvince.cities
      .filter((city) => !query || normalizeSearch(city.name).includes(query))
      .map((city) => `<button class="picker-option" type="button" role="option" data-city-id="${city.id}"><span>${escapeHtml(city.name)}</span><span class="picker-province-caption">انتخاب شهرستان</span></button>`);
  } else {
    items = (state.config?.provinces ?? [])
      .filter((province) => !query || normalizeSearch(province.name).includes(query))
      .map((province) => `<button class="picker-option" type="button" role="option" data-province-id="${province.id}"><span>${escapeHtml(province.name)}</span><svg class="icon"><use href="#icon-chevron"/></svg></button>`);
  }
  pickerList.innerHTML = items.length ? items.join('') : '<p class="empty-state">موردی پیدا نشد.</p>';
}

function openPicker() {
  if (!state.config) return;
  const selected = state.city ? findCity(state.city.id) : null;
  state.pickerProvince = selected?.province ?? null;
  pickerSearch.value = '';
  renderPickerList();
  if (!picker.open) picker.showModal();
  pickerSearch.focus();
}

function scopeName(item) {
  if (item.scope.type === 'country') return 'کشوری';
  if (item.scope.type === 'province') return `استان ${item.scope.name}`;
  return `شهر ${item.scope.name}`;
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

function coverMarkup(item) {
  const placeholder = placeholderMarkup(item.cover?.dominant_color);
  if (!item.cover?.src) return `<div class="card-cover-frame">${placeholder}</div>`;
  return `<div class="card-cover-frame">${placeholder}<img class="card-cover" src="${escapeHtml(item.cover.src)}" srcset="${escapeHtml(item.cover.srcset ?? '')}" sizes="(max-width: 767px) 100vw, (max-width: 899px) 50vw, 33vw" width="${Number(item.cover.width) || 800}" height="${Number(item.cover.height) || 450}" loading="lazy" decoding="async" alt=""></div>`;
}

function cardMarkup(item, pinned = false) {
  const category = item.category?.name ? `<span class="card-kicker">${escapeHtml(item.category.name)}</span>` : '';
  const urgent = item.is_urgent ? '<span class="urgent-label">فوری</span>' : '';
  const summary = item.summary ? `<p class="card-summary">${escapeHtml(item.summary)}</p>` : '';
  if (pinned) {
    const thumbnail = item.cover?.src
      ? `<div class="pinned-cover-frame">${placeholderMarkup(item.cover.dominant_color)}<img src="${escapeHtml(item.cover.src)}" width="104" height="59" loading="lazy" alt=""></div>`
      : `<div class="pinned-cover-frame">${placeholderMarkup(item.cover?.dominant_color)}</div>`;
    return `<article class="pinned-card" data-news-id="${item.id}" tabindex="0" role="link">${thumbnail}<div><div class="card-meta"><span class="card-kicker">${item.is_urgent ? 'خبر فوری' : 'خبر مهم'}</span></div><h2>${escapeHtml(item.title)}</h2></div></article>`;
  }
  return `<article class="news-card${item.is_urgent ? ' is-urgent' : ''}" data-news-id="${item.id}" tabindex="0" role="link" aria-label="${escapeHtml(item.title)}">
    ${coverMarkup(item)}
    <div class="card-content"><div class="card-meta">${category}${urgent}<span class="scope-badge" data-scope="${escapeHtml(item.scope.type)}">${escapeHtml(scopeName(item))}</span></div>
    <h2>${escapeHtml(item.title)}</h2>${summary}<p class="card-date">${relativeDate(item.published_at)}</p></div>
  </article>`;
}

function showSkeletons(count = 4) {
  for (let index = 0; index < count; index += 1) {
    const skeleton = document.createElement('div');
    skeleton.className = 'news-skeleton';
    skeleton.setAttribute('aria-hidden', 'true');
    feed.append(skeleton);
  }
}

function clearFeed() {
  intersectionObserver?.unobserve(sentinel);
  feed.replaceChildren();
  state.entries = [];
  state.spacer = null;
  state.removedCardCount = 0;
  state.cursor = null;
  state.ended = false;
  state.firstId = null;
  pinnedStrip.replaceChildren();
  pinnedStrip.hidden = true;
  newItemsBanner.hidden = true;
}

function resetFeed({ scroll = false } = {}) {
  clearFeed();
  if (!state.city) {
    feedMessage.textContent = 'برای نمایش خبرها، ابتدا شهرستان خود را انتخاب کنید.';
    return;
  }
  feedMessage.textContent = '';
  if (scroll) {
    const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    document.getElementById('feed-heading').scrollIntoView({ block: 'start', behavior });
  }
  loadMore();
}

function updateSpacerHeight() {
  if (!state.spacer) return;
  const cardHeight = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--card-height')) || 410;
  const gap = Number.parseFloat(getComputedStyle(feed).rowGap) || 0;
  const spacerHeight = state.removedCardCount * cardHeight + Math.max(0, state.removedCardCount - 1) * gap;
  const width = Math.max(1, feed.clientWidth);
  state.spacer.height = Math.max(1, Math.round(spacerHeight * 1000 / width));
}

function recycleFeed() {
  const excess = state.entries.length - 60;
  if (excess <= 0) return;
  const removed = state.entries.splice(0, excess);
  state.removedCardCount += removed.length;
  for (const entry of removed) entry.node.remove();
  if (!state.spacer) {
    state.spacer = document.createElement('img');
    state.spacer.className = 'feed-spacer';
    state.spacer.src = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
    state.spacer.width = 1000;
    state.spacer.alt = '';
    state.spacer.setAttribute('aria-hidden', 'true');
    feed.prepend(state.spacer);
  }
  updateSpacerHeight();
}

async function loadMore() {
  if (!state.city || state.loading || state.ended) return;
  state.loading = true;
  feed.setAttribute('aria-busy', 'true');
  showSkeletons(3);
  const params = new URLSearchParams({ city: state.city.id, scope: state.scope, limit: '12' });
  if (state.cursor) params.set('cursor', state.cursor);
  try {
    const data = await getJson(`/api/public/feed?${params}`);
    feed.querySelectorAll('.news-skeleton').forEach((node) => node.remove());
    if (!state.cursor && Array.isArray(data.pinned) && data.pinned.length) {
      pinnedStrip.innerHTML = data.pinned.map((item) => cardMarkup(item, true)).join('');
      pinnedStrip.hidden = false;
    } else if (!state.cursor) pinnedStrip.hidden = true;
    for (const item of data.items) {
      const template = document.createElement('template');
      template.innerHTML = cardMarkup(item);
      const node = template.content.firstElementChild;
      feed.append(node);
      state.entries.push({ id: item.id, node });
      if (state.firstId == null) state.firstId = item.id;
    }
    state.cursor = data.next_cursor;
    state.ended = !data.next_cursor;
    state.loading = false;
    feed.setAttribute('aria-busy', 'false');
    if (state.entries.length) {
      feedMessage.textContent = state.ended ? 'همین بود؛ خبر تازه‌ای برای نمایش نیست.' : '';
    } else {
      feed.innerHTML = '<div class="empty-state">در این محدوده هنوز خبری منتشر نشده است.</div>';
      feedMessage.textContent = '';
    }
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

async function checkForNewItems() {
  if (!state.city || state.newsId || state.loading || state.firstId == null) return;
  const params = new URLSearchParams({ city: state.city.id, scope: state.scope, limit: '1' });
  try {
    const data = await getJson(`/api/public/feed?${params}`);
    if (data.items?.[0]?.id && Number(data.items[0].id) !== Number(state.firstId)) newItemsBanner.hidden = false;
  } catch {}
}

function updateScopeButtons() {
  document.querySelectorAll('.scope-chip').forEach((button) => {
    const active = button.dataset.scope === state.scope;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
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
}

function initTheme() {
  const button = document.querySelector('.theme-toggle');
  const showTheme = () => {
    const theme = document.documentElement.dataset.theme || 'auto';
    const use = button.querySelector('use');
    use.setAttribute('href', theme === 'dark' ? '#icon-sun' : '#icon-moon');
    button.setAttribute('aria-label', `حالت نمایش: ${theme === 'auto' ? 'خودکار' : theme === 'dark' ? 'تیره' : 'روشن'}؛ برای تغییر کلیک کنید`);
  };
  showTheme();
  button.addEventListener('click', () => {
    const current = document.documentElement.dataset.theme || 'auto';
    const next = current === 'auto' ? 'light' : current === 'light' ? 'dark' : 'auto';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('pnu.theme', next); } catch {}
    showTheme();
  });
}

function setMediaMetadata(title, artist) {
  if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title, artist, album: state.radioTitle || 'رادیو' });
    navigator.mediaSession.setActionHandler('play', playRadio);
    navigator.mediaSession.setActionHandler('pause', () => radioAudio?.pause());
  } catch {}
}

async function playRadio() {
  if (!radioAudio || !state.radioUrl) return;
  if (!radioAudio.src) radioAudio.src = state.radioUrl;
  try { await radioAudio.play(); } catch { showToast('پخش رادیو آغاز نشد؛ اتصال را بررسی کنید.'); }
}

async function refreshNowPlaying() {
  try {
    const data = await getJson('/api/public/radio');
    const caption = radioRoot.querySelector('.radio-now-playing');
    if (!caption) return;
    const song = data.now_playing;
    caption.textContent = song?.title ? `${song.title}${song.artist ? ` — ${song.artist}` : ''}` : 'پخش زندهٔ رادیو';
    if (song?.title) setMediaMetadata(song.title, song.artist || state.radioTitle);
  } catch {}
}

function renderRadio(radio) {
  const enabled = radio?.enabled && radio.stream_url;
  if (!enabled) {
    if (radioAudio) {
      radioAudio.pause();
      radioAudio.removeAttribute('src');
      radioAudio.load();
    }
    radioRoot.replaceChildren();
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.setActionHandler('play', null);
        navigator.mediaSession.setActionHandler('pause', null);
        navigator.mediaSession.metadata = null;
      } catch {}
    }
    state.radioUrl = '';
    state.radioTitle = '';
    clearInterval(state.nowPlayingTimer);
    return;
  }
  const changed = state.radioUrl !== radio.stream_url;
  if (changed && radioAudio) {
    radioAudio.pause();
    radioAudio.removeAttribute('src');
    radioAudio.load();
  }
  state.radioUrl = radio.stream_url;
  state.radioTitle = radio.title || 'رادیو';
  if (!radioAudio) {
    radioAudio = document.createElement('audio');
    radioAudio.preload = 'none';
    radioAudio.volume = .8;
    try {
      const volume = Number(localStorage.getItem('pnu.radioVolume'));
      if (volume >= 0 && volume <= 1) radioAudio.volume = volume;
    } catch {}
    radioAudio.addEventListener('play', () => {
      const button = radioRoot.querySelector('.radio-play');
      if (button) {
        button.innerHTML = '<svg class="icon"><use href="#icon-pause"/></svg>';
        button.setAttribute('aria-label', 'توقف رادیو');
      }
    });
    radioAudio.addEventListener('pause', () => {
      const button = radioRoot.querySelector('.radio-play');
      if (button) {
        button.innerHTML = '<svg class="icon"><use href="#icon-play"/></svg>';
        button.setAttribute('aria-label', 'پخش رادیو');
      }
    });
    radioAudio.addEventListener('error', () => showToast('پخش رادیو در دسترس نیست.'));
  }
  if (!radioRoot.querySelector('.radio-bar')) {
    radioRoot.innerHTML = `<section class="radio-bar" aria-label="پخش رادیوی دانشگاه">
      <button class="audio-button radio-play" type="button" aria-label="پخش رادیو"><svg class="icon"><use href="#icon-play"/></svg></button>
      <div class="radio-info"><strong class="radio-title"></strong><span class="radio-now-playing">پخش زندهٔ رادیو</span></div>
      <label class="volume-control" aria-label="بلندی صدا"><svg class="icon"><use href="#icon-volume"/></svg><input class="radio-volume" type="range" min="0" max="1" step="0.05" aria-label="بلندی صدا"></label>
    </section>`;
    radioRoot.querySelector('.radio-volume').value = String(radioAudio.volume);
  }
  radioRoot.querySelector('.radio-title').textContent = state.radioTitle;
  setMediaMetadata(state.radioTitle, 'رادیوی اینترنتی');
  clearInterval(state.nowPlayingTimer);
  refreshNowPlaying();
  state.nowPlayingTimer = setInterval(refreshNowPlaying, 20_000);
}

function initRadioEvents() {
  radioRoot.addEventListener('click', async (event) => {
    const button = event.target.closest('.radio-play');
    if (!button || !state.radioUrl || !radioAudio) return;
    if (!radioAudio.paused) {
      radioAudio.pause();
      return;
    }
    await playRadio();
  });
  radioRoot.addEventListener('input', (event) => {
    if (!event.target.matches('.radio-volume') || !radioAudio) return;
    radioAudio.volume = Number(event.target.value);
    try { localStorage.setItem('pnu.radioVolume', String(radioAudio.volume)); } catch {}
  });
}

async function refreshConfig() {
  try {
    const nextConfig = await getJson('/api/public/config');
    state.config = nextConfig;
    const currentNewsTitle = state.newsId ? document.querySelector('#news-view h1')?.textContent : null;
    document.title = currentNewsTitle ? `${currentNewsTitle} — ${nextConfig.site_title || 'اخبار پیام نور'}` : nextConfig.site_title || 'اخبار پیام نور';
    document.getElementById('site-title').textContent = nextConfig.site_title || 'اخبار پیام نور';
    const selected = state.city ? findCity(state.city.id) : null;
    if (state.city && !selected) {
      state.city = null;
      state.province = null;
      try { localStorage.removeItem('pnu.city'); } catch {}
      updateSelectedCity();
      clearFeed();
      feedMessage.textContent = 'شهرستان قبلی دیگر در دسترس نیست؛ لطفاً شهرستان دیگری انتخاب کنید.';
      openPicker();
    } else if (selected) {
      state.city = selected.city;
      state.province = selected.province;
      updateSelectedCity();
    }
    renderRadio(nextConfig.radio);
    if (state.city && feed.childElementCount === 0 && !state.loading) resetFeed();
    renderPickerList();
  } catch (error) {
    if (!state.config) feedMessage.textContent = 'ارتباط با سرور برقرار نشد. پس از اتصال دوباره تلاش کنید.';
  }
}

async function initializeReader({ newsOnly = false } = {}) {
  initTheme();
  initFontScale();
  initRadioEvents();
  intersectionObserver = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) loadMore();
  }, { rootMargin: '700px 0px' });
  intersectionObserver.observe(sentinel);
  try {
    const config = await getJson('/api/public/config');
    state.config = config;
    document.title = config.site_title || 'اخبار پیام نور';
    document.getElementById('site-title').textContent = config.site_title || 'اخبار پیام نور';
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
        feedMessage.textContent = 'برای نمایش خبرها، ابتدا شهرستان خود را انتخاب کنید.';
        openPicker();
      }
    }
    renderRadio(config.radio);
    if (!newsOnly) renderPickerList();
  } catch {
    feedMessage.textContent = 'ارتباط با سرور برقرار نشد. صفحه را دوباره بارگذاری کنید.';
  }
  state.refreshTimer = setInterval(refreshConfig, 15_000);
  setInterval(checkForNewItems, 60_000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

async function loadNewsPage(id, { initial = false } = {}) {
  if (!initial) {
    app.hidden = true;
    newsView.hidden = false;
    intersectionObserver?.unobserve(sentinel);
  }
  state.newsId = Number(id);
  if (!initial) newsView.innerHTML = '<div class="news-page"><div class="news-skeleton" aria-hidden="true"></div></div>';
  try {
    const { item } = await getJson(`/api/public/news/${id}`);
    state.newsId = Number(item.id);
    const target = initial ? app : newsView;
    target.innerHTML = renderNewsPage(item, initial);
    target.hidden = false;
    if (!initial) app.hidden = true;
    document.title = `${item.title} — ${state.config?.site_title || 'اخبار پیام نور'}`;
    if ('mediaSession' in navigator) setMediaMetadata(item.title, item.publisher_unit);
  } catch (error) {
    const target = initial ? app : newsView;
    target.innerHTML = `<section class="reader-error"><h1>خبر پیدا نشد</h1><p>${escapeHtml(error.message)}</p><a class="news-back" href="/">بازگشت به خبرها</a></section>`;
    target.hidden = false;
  }
}

function renderNewsPage(item, initial) {
  const hasPerson = Boolean(item.publisher_name);
  const byline = hasPerson ? `منتشرکننده: <strong>${escapeHtml(item.publisher_name)}</strong> — ${escapeHtml(item.publisher_unit)}` : `منتشرکننده: ${escapeHtml(item.publisher_unit)}`;
  const category = item.category?.name ? `<span>${escapeHtml(item.category.name)}</span>` : '';
  const date = new Date(item.published_at);
  const fullDate = `${dateFormatter.format(date)} — ${timeFormatter.format(date)}`;
  const cover = item.cover?.src ? `<div class="news-page-cover-frame">${placeholderMarkup(item.cover.dominant_color)}<img class="news-page-cover" src="${escapeHtml(item.cover.src)}" srcset="${escapeHtml(item.cover.srcset ?? '')}" sizes="(max-width: 790px) 100vw, 790px" width="${Number(item.cover.width) || 1280}" height="${Number(item.cover.height) || 720}" fetchpriority="high" alt="${escapeHtml(item.title)}"></div>` : '';
  const gallery = (item.images ?? []).filter((image) => image.src && Number(image.id) !== Number(item.cover?.id)).map((image) => `<div class="gallery-image-frame">${placeholderMarkup(image.dominant_color)}<img src="${escapeHtml(image.src)}" srcset="${escapeHtml(image.srcset ?? '')}" sizes="(max-width: 767px) 100vw, 50vw" width="${Number(image.width) || 800}" height="${Number(image.height) || 600}" loading="lazy" decoding="async" alt="${escapeHtml(image.original_name)}"></div>`).join('');
  const files = (item.files ?? []).map((file) => `<a class="attachment-link" href="${escapeHtml(file.url)}"><span>▤ ${escapeHtml(file.original_name)}</span><span>${escapeHtml(formatBytes(file.size_bytes))}</span></a>`).join('');
  return `${initial ? '' : '<a class="news-back" href="/" data-reader-back><svg class="icon"><use href="#icon-chevron"/></svg>بازگشت به خبرها</a>'}
    <article class="news-page">${cover}<h1>${escapeHtml(item.title)}</h1><p class="news-byline">${byline}</p>
    <div class="news-details">${category}<time datetime="${escapeHtml(item.published_at)}">${fullDate}</time><span>${digits.format(item.view_count)} بازدید</span></div>
    <div class="news-body">${item.body_html}</div>
    ${gallery ? `<section class="news-gallery" aria-label="تصاویر خبر">${gallery}</section>` : ''}
    ${files ? `<section class="attachment-list"><h2>پیوست‌ها</h2>${files}</section>` : ''}
    <div class="news-actions"><button type="button" class="share-button" data-share><svg class="icon"><use href="#icon-share"/></svg>اشتراک‌گذاری خبر</button></div>
    </article>`;
}

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
  document.title = state.config?.site_title || 'اخبار پیام نور';
  newsView.hidden = true;
  app.hidden = false;
  intersectionObserver?.observe(sentinel);
  const scrollY = Number(history.state?.readerScrollY) || 0;
  requestAnimationFrame(() => window.scrollTo(0, scrollY));
}

document.getElementById('city-button').addEventListener('click', openPicker);
document.addEventListener('error', (event) => {
  if (!(event.target instanceof HTMLImageElement) || event.target.classList.contains('cover-placeholder')) return;
  if (event.target.classList.contains('card-cover') || event.target.classList.contains('news-page-cover') || event.target.closest('.gallery-image-frame,.pinned-cover-frame')) event.target.hidden = true;
}, true);
document.querySelector('.picker-close').addEventListener('click', () => picker.close());
picker.addEventListener('click', (event) => {
  if (event.target === picker) picker.close();
  const provinceButton = event.target.closest('[data-province-id]');
  if (provinceButton) {
    state.pickerProvince = state.config.provinces.find((province) => Number(province.id) === Number(provinceButton.dataset.provinceId));
    pickerSearch.value = '';
    renderPickerList();
    pickerSearch.focus();
  }
  const cityButton = event.target.closest('[data-city-id]');
  if (cityButton && state.pickerProvince) {
    const city = state.pickerProvince.cities.find((item) => Number(item.id) === Number(cityButton.dataset.cityId));
    if (city) setCity(city, state.pickerProvince);
  }
});
pickerBack.addEventListener('click', () => {
  state.pickerProvince = null;
  pickerSearch.value = '';
  renderPickerList();
  pickerSearch.focus();
});
pickerSearch.addEventListener('input', renderPickerList);
document.querySelector('.scope-row').addEventListener('click', (event) => {
  const button = event.target.closest('[data-scope]');
  if (!button || state.scope === button.dataset.scope) return;
  state.scope = button.dataset.scope;
  updateScopeButtons();
  resetFeed();
});
feed.addEventListener('click', (event) => {
  const card = event.target.closest('[data-news-id]');
  if (card) navigateToNews(card.dataset.newsId);
});
pinnedStrip.addEventListener('click', (event) => {
  const card = event.target.closest('[data-news-id]');
  if (card) navigateToNews(card.dataset.newsId);
});
feed.addEventListener('keydown', (event) => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-news-id]')) {
    event.preventDefault();
    navigateToNews(event.target.dataset.newsId);
  }
});
pinnedStrip.addEventListener('keydown', (event) => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-news-id]')) {
    event.preventDefault();
    navigateToNews(event.target.dataset.newsId);
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
window.addEventListener('resize', updateSpacerHeight, { passive: true });
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
