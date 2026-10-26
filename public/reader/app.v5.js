const app = document.getElementById("app");
const newsView = document.getElementById("news-view");
const feed = document.getElementById("feed");
const picker = document.getElementById("city-picker");
const pickerList = document.getElementById("picker-list");
const pickerSearch = document.getElementById("picker-search");
const pickerBack = document.getElementById("picker-back");
const feedMessage = document.getElementById("feed-message");
const searchField = document.querySelector(".search-field");
const sentinel = document.getElementById("feed-sentinel");
const pinnedStrip = document.getElementById("pinned-strip");
const newItemsBanner = document.getElementById("new-items-banner");
const radioRoot = document.getElementById("radio-root");
const installRoot = document.getElementById("install-root");
const state = {
  config: null,
  city: null,
  province: null,
  pickerProvince: null,
  scope: "all", // always "all" for now; will become a setting later
  cursor: null,
  loading: false,
  ended: false,
  entries: [],
  spacer: null,
  spacerHeight: 0,
  pinnedIds: new Set(),
  firstId: null,
  newsId: null,
  refreshTimer: null,
  radioUrl: "",
  radioTitle: "",
  nowPlayingTimer: null,
  toastTimer: null,
  fontScale: 1,
};
let radioAudio = null;
let intersectionObserver = null;

const digits = new Intl.NumberFormat("fa-IR");
const dateFormatter = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
  timeZone: "Asia/Tehran",
  day: "numeric",
  month: "long",
  year: "numeric",
});
const timeFormatter = new Intl.DateTimeFormat("fa-IR", {
  timeZone: "Asia/Tehran",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
}

function normalizeSearch(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[\u064b-\u065f\u0670]/g, "")
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x6f0))
    .replace(/ـ/g, "")
    .replace(/[\u200c\u200e\u200f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function searchKey(value) {
  return normalizeSearch(value).replace(/ /g, "");
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(
    () => toast.classList.remove("is-visible"),
    2600,
  );
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });
  let body;
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  if (!response.ok) throw new Error(body.error || "دریافت اطلاعات ناموفق بود.");
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
  const label = document.getElementById("selected-city-label");
  const description = document.getElementById("feed-description");
  if (!state.city || !state.province) {
    label.textContent = "انتخاب شهرستان";
    description.textContent =
      "برای دیدن خبرهای مرتبط، شهرستان خود را انتخاب کنید.";
    description.hidden = false;
    return;
  }
  label.textContent = `${state.city.name} · ${state.province.name}`;
  description.textContent = "";
  description.hidden = true;
}

function setCity(city, province) {
  state.city = city;
  state.province = province;
  try {
    localStorage.setItem("pnu.city", String(city.id));
  } catch {}
  updateSelectedCity();
  picker.close();
  newItemsBanner.hidden = true;
  resetFeed();
}

function pickerNotice(title, detail = "") {
  return `<div class="picker-notice"><strong>${escapeHtml(title)}</strong>${detail ? `<span>${escapeHtml(detail)}</span>` : ""}</div>`;
}

function cityOption(city, caption = "") {
  const selected = state.city && Number(state.city.id) === Number(city.id);
  return `<button class="picker-option${selected ? " is-selected" : ""}" type="button" data-city-id="${city.id}"><span class="picker-name">${escapeHtml(city.name)}</span>${caption ? `<span class="picker-meta">${escapeHtml(caption)}</span>` : ""}${selected ? '<svg class="icon"><use href="#icon-check"/></svg>' : ""}</button>`;
}

function renderPickerList() {
  const province = state.pickerProvince;
  const query = searchKey(pickerSearch.value);
  pickerBack.hidden = !province;
  document.getElementById("picker-step").textContent = province
    ? "مرحلهٔ ۲ از ۲"
    : "مرحلهٔ ۱ از ۲";
  document.getElementById("picker-title").textContent = province
    ? `مراکز دانشگاهی ${province.name}`
    : "استان خود را انتخاب کنید";
  pickerSearch.placeholder = province
    ? "جست‌وجوی شهرستان"
    : "جست‌وجوی استان یا شهرستان";
  if (!state.config) {
    searchField.hidden = true;
    pickerList.innerHTML = pickerNotice("در حال دریافت فهرست مناطق…");
    return;
  }
  if (province && !province.cities.length) {
    searchField.hidden = true;
    pickerList.innerHTML = pickerNotice(
      "فعلاً برای استان شما فعال نشده است.",
      "پس از فعال شدن، مرکز دانشگاهی خود را از همین‌جا انتخاب کنید.",
    );
    return;
  }
  searchField.hidden = false;
  if (province) {
    const cities = province.cities.filter(
      (city) => !query || searchKey(city.name).includes(query),
    );
    pickerList.innerHTML = cities.length
      ? cities.map((city) => cityOption(city)).join("")
      : pickerNotice("شهرستانی با این نام پیدا نشد.");
    return;
  }
  const provinces = state.config.provinces.filter(
    (item) => !query || searchKey(item.name).includes(query),
  );
  const provinceItems = provinces.map((item) => {
    const count = item.cities.length;
    const meta = count ? `${digits.format(count)} شهرستان` : "فعال نشده";
    return `<button class="picker-option${count ? "" : " is-inactive"}" type="button" data-province-id="${item.id}"><span class="picker-name">${escapeHtml(item.name)}</span><span class="picker-meta">${meta}</span><svg class="icon"><use href="#icon-chevron"/></svg></button>`;
  });
  const cityItems = query
    ? state.config.provinces.flatMap((item) =>
        item.cities
          .filter((city) => searchKey(city.name).includes(query))
          .map((city) => cityOption(city, item.name)),
      )
    : [];
  const parts = [];
  if (provinceItems.length)
    parts.push(
      ...(cityItems.length
        ? ['<p class="picker-group-title">استان‌ها</p>']
        : []),
      ...provinceItems,
    );
  if (cityItems.length)
    parts.push('<p class="picker-group-title">شهرستان‌ها</p>', ...cityItems);
  pickerList.innerHTML = parts.length
    ? parts.join("")
    : pickerNotice("موردی پیدا نشد.");
}

function focusPickerSearch() {
  if (!searchField.hidden && matchMedia("(pointer: fine)").matches)
    pickerSearch.focus();
}

function openPicker() {
  if (!state.config) {
    showToast("در حال دریافت فهرست مناطق…");
    return;
  }
  const selected = state.city ? findCity(state.city.id) : null;
  state.pickerProvince = selected?.province ?? null;
  pickerSearch.value = "";
  renderPickerList();
  if (!picker.open) picker.showModal();
  pickerList.scrollTop = 0;
  focusPickerSearch();
}

function scopeName(item) {
  if (item.scope.type === "country") return "کشوری";
  if (item.scope.type === "province") return `استان ${item.scope.name}`;
  return `شهر ${item.scope.name}`;
}

function relativeDate(isoDate) {
  const date = new Date(isoDate);
  const delta = Math.max(0, Date.now() - date.getTime());
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return "لحظاتی پیش";
  if (delta < hour)
    return `${digits.format(Math.floor(delta / minute))} دقیقه پیش`;
  if (delta < day) return `${digits.format(Math.floor(delta / hour))} ساعت پیش`;
  if (delta < 2 * day) return "دیروز";
  if (delta < 7 * day)
    return `${digits.format(Math.floor(delta / day))} روز پیش`;
  return `${dateFormatter.format(date)} — ${timeFormatter.format(date)}`;
}

function safeColorCode(value) {
  return /^#[a-f\d]{6}$/i.test(value ?? "") ? value.slice(1) : "eef3fa";
}

function placeholderMarkup(color, className = "cover-placeholder") {
  return `<img class="${className}" src="/media/placeholder/${safeColorCode(color)}.svg" width="16" height="9" alt="" aria-hidden="true">`;
}

const CARD_IMAGE_SIZES =
  "(max-width: 639px) 100vw, (max-width: 959px) 50vw, 33vw";
const FEATURED_IMAGE_SIZES = "(max-width: 959px) 100vw, 650px";

function coverMarkup(item, featured, overlay = "") {
  const placeholder = placeholderMarkup(item.cover.dominant_color);
  return `<div class="card-cover-frame">${placeholder}<img class="card-cover" src="${escapeHtml(item.cover.src)}" srcset="${escapeHtml(item.cover.srcset ?? "")}" sizes="${featured ? FEATURED_IMAGE_SIZES : CARD_IMAGE_SIZES}" width="${Number(item.cover.width) || 800}" height="${Number(item.cover.height) || 450}" loading="lazy" decoding="async" alt="">${overlay}</div>`;
}

function pinnedMarkup(item) {
  const thumbnail = item.cover?.src
    ? `<div class="pinned-cover-frame">${placeholderMarkup(item.cover.dominant_color)}<img src="${escapeHtml(item.cover.src)}" width="104" height="59" loading="lazy" alt=""></div>`
    : "";
  const classes = [
    "pinned-card",
    item.is_urgent ? "is-urgent" : "",
    thumbnail ? "" : "no-thumb",
  ]
    .filter(Boolean)
    .join(" ");
  return `<article class="${classes}" data-news-id="${item.id}" tabindex="0" role="link" aria-label="${escapeHtml(item.title)}">${thumbnail}<div><div class="card-meta"><span class="card-kicker">${item.is_urgent ? "خبر فوری" : "خبر مهم"}</span></div><h2>${escapeHtml(item.title)}</h2></div></article>`;
}

function cardMarkup(item, { featured = false } = {}) {
  const hasCover = Boolean(item.cover?.src);
  const badge = `<span class="scope-badge" data-scope="${escapeHtml(item.scope.type)}">${escapeHtml(scopeName(item))}</span>`;
  const category = item.category?.name
    ? `<span class="card-kicker">${escapeHtml(item.category.name)}</span>`
    : "";
  const urgent = item.is_urgent ? '<span class="urgent-label">فوری</span>' : "";
  const source = item.publisher_unit
    ? `<span class="card-source">${escapeHtml(item.publisher_unit)}</span><i aria-hidden="true"></i>`
    : "";
  const time = `<time datetime="${escapeHtml(item.published_at)}">${relativeDate(item.published_at)}</time>`;
  const summary = item.summary
    ? `<p class="card-summary">${escapeHtml(item.summary)}</p>`
    : "";
  const classes = [
    "news-card",
    item.is_urgent ? "is-urgent" : "",
    hasCover ? "" : "no-cover",
    featured ? "is-featured" : "",
  ]
    .filter(Boolean)
    .join(" ");
  // With a cover, all meta sits on a translucent black strip over the image; only title and summary stay below it.
  const overlay = `<div class="card-meta-overlay">${badge}${category}${urgent}<span class="overlay-end">${source}${time}</span></div>`;
  const body = hasCover
    ? `<div class="card-content"><h2>${escapeHtml(item.title)}</h2>${summary}</div>`
    : `<div class="card-content"><div class="card-meta">${badge}${category}${urgent}</div><h2>${escapeHtml(item.title)}</h2>${summary}<div class="card-foot">${source}${time}</div></div>`;
  return `<article class="${classes}" data-news-id="${item.id}" data-scope="${escapeHtml(item.scope.type)}" tabindex="0" role="link" aria-label="${escapeHtml(item.title)}">
    ${hasCover ? coverMarkup(item, featured, overlay) : ""}
    ${body}
  </article>`;
}

function showSkeletons(count = 4) {
  for (let index = 0; index < count; index += 1) {
    const skeleton = document.createElement("div");
    skeleton.className = "news-skeleton";
    skeleton.setAttribute("aria-hidden", "true");
    feed.append(skeleton);
  }
}

function clearFeed() {
  intersectionObserver?.unobserve(sentinel);
  feed.replaceChildren();
  state.entries = [];
  state.spacer = null;
  state.spacerHeight = 0;
  state.pinnedIds = new Set();
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
    feedMessage.textContent = "";
    feed.innerHTML =
      '<div class="empty-state"><p>برای دیدن خبرها، ابتدا شهرستان خود را انتخاب کنید.</p><button type="button" class="button-primary" data-open-picker>انتخاب شهرستان</button></div>';
    return;
  }
  feedMessage.textContent = "";
  if (scroll) {
    const behavior = matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "auto"
      : "smooth";
    document
      .getElementById("feed-heading")
      .scrollIntoView({ block: "start", behavior });
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
    state.spacer = document.createElement("div");
    state.spacer.className = "feed-spacer";
    state.spacer.setAttribute("aria-hidden", "true");
    feed.prepend(state.spacer);
  }
  state.spacer.style.height = `${state.spacerHeight}px`;
  state.spacerHeight += before - feed.getBoundingClientRect().height;
  state.spacer.style.height = `${Math.max(0, state.spacerHeight)}px`;
}

async function loadMore() {
  if (!state.city || state.loading || state.ended) return;
  state.loading = true;
  feed.setAttribute("aria-busy", "true");
  showSkeletons(3);
  const params = new URLSearchParams({
    city: state.city.id,
    scope: state.scope,
    limit: "12",
  });
  if (state.cursor) params.set("cursor", state.cursor);
  try {
    const data = await getJson(`/api/public/feed?${params}`);
    feed.querySelectorAll(".news-skeleton").forEach((node) => node.remove());
    const isFirstPage = !state.cursor;
    if (isFirstPage) {
      const pinned = Array.isArray(data.pinned) ? data.pinned : [];
      state.pinnedIds = new Set(pinned.map((item) => Number(item.id)));
      pinnedStrip.hidden = !pinned.length;
      if (pinned.length)
        pinnedStrip.innerHTML = pinned.map(pinnedMarkup).join("");
    }
    for (const item of data.items) {
      if (state.firstId == null) state.firstId = item.id;
      if (state.pinnedIds.has(Number(item.id))) continue;
      const template = document.createElement("template");
      template.innerHTML = cardMarkup(item, {
        featured:
          isFirstPage && state.entries.length === 0 && Boolean(item.cover?.src),
      });
      const node = template.content.firstElementChild;
      feed.append(node);
      state.entries.push({ id: item.id, node });
    }
    state.cursor = data.next_cursor;
    state.ended = !data.next_cursor;
    state.loading = false;
    feed.setAttribute("aria-busy", "false");
    if (state.entries.length || !pinnedStrip.hidden) {
      feedMessage.textContent = state.ended
        ? "همین بود؛ خبر تازه‌ای برای نمایش نیست."
        : "";
    } else {
      feed.innerHTML =
        '<div class="empty-state">در این محدوده هنوز خبری منتشر نشده است.</div>';
      feedMessage.textContent = "";
    }
    recycleFeed();
    if (state.ended) intersectionObserver?.unobserve(sentinel);
    else intersectionObserver?.observe(sentinel);
  } catch (error) {
    feed.querySelectorAll(".news-skeleton").forEach((node) => node.remove());
    state.loading = false;
    feed.setAttribute("aria-busy", "false");
    feedMessage.textContent = error.message || "بارگذاری خبرها ناموفق بود.";
  }
}

async function checkForNewItems() {
  if (!state.city || state.newsId || state.loading || state.firstId == null)
    return;
  const params = new URLSearchParams({
    city: state.city.id,
    scope: state.scope,
    limit: "1",
  });
  try {
    const data = await getJson(`/api/public/feed?${params}`);
    if (
      data.items?.[0]?.id &&
      Number(data.items[0].id) !== Number(state.firstId)
    )
      newItemsBanner.hidden = false;
  } catch {}
}

function applyFontScale() {
  document.documentElement.classList.remove(
    "font-scale-90",
    "font-scale-95",
    "font-scale-105",
    "font-scale-110",
  );
  if (state.fontScale !== 1)
    document.documentElement.classList.add(
      `font-scale-${Math.round(state.fontScale * 100)}`,
    );
}

function initFontScale() {
  try {
    const scale = Number(localStorage.getItem("pnu.fontScale"));
    if (scale >= 0.9 && scale <= 1.1) state.fontScale = scale;
  } catch {}
  applyFontScale();
  document
    .querySelector(".font-down")
    .addEventListener("click", () => changeFontScale(-0.05));
  document
    .querySelector(".font-up")
    .addEventListener("click", () => changeFontScale(0.05));
}

function changeFontScale(delta) {
  state.fontScale = Math.min(
    1.1,
    Math.max(0.9, Math.round((state.fontScale + delta) * 100) / 100),
  );
  try {
    localStorage.setItem("pnu.fontScale", String(state.fontScale));
  } catch {}
  applyFontScale();
}

function initTheme() {
  const button = document.querySelector(".theme-toggle");
  const showTheme = () => {
    const dark = document.documentElement.dataset.theme === "dark";
    button
      .querySelector("use")
      .setAttribute("href", dark ? "#icon-sun" : "#icon-moon");
    button.setAttribute(
      "aria-label",
      dark ? "تغییر به حالت روشن" : "تغییر به حالت تیره",
    );
  };
  showTheme();
  button.addEventListener("click", () => {
    const next =
      document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("pnu.theme", next);
    } catch {}
    showTheme();
  });
}

function setMediaMetadata(title, artist) {
  if (!("mediaSession" in navigator) || typeof MediaMetadata === "undefined")
    return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title,
      artist,
      album: state.radioTitle || "رادیو",
    });
    navigator.mediaSession.setActionHandler("play", playRadio);
    navigator.mediaSession.setActionHandler("pause", () => radioAudio?.pause());
  } catch {}
}

async function playRadio() {
  if (!radioAudio || !state.radioUrl) return;
  if (!radioAudio.src) radioAudio.src = state.radioUrl;
  try {
    await radioAudio.play();
  } catch {
    showToast("پخش رادیو آغاز نشد؛ اتصال را بررسی کنید.");
  }
}

async function refreshNowPlaying() {
  try {
    const data = await getJson("/api/public/radio");
    const caption = radioRoot.querySelector(".radio-now-playing");
    if (!caption) return;
    const song = data.now_playing;
    caption.textContent = song?.title
      ? `${song.title}${song.artist ? ` — ${song.artist}` : ""}`
      : "پخش زندهٔ رادیو";
    if (song?.title)
      setMediaMetadata(song.title, song.artist || state.radioTitle);
  } catch {}
}

function renderRadio(radio) {
  const enabled = radio?.enabled && radio.stream_url;
  if (!enabled) {
    if (radioAudio) {
      radioAudio.pause();
      radioAudio.removeAttribute("src");
      radioAudio.load();
    }
    radioRoot.replaceChildren();
    if ("mediaSession" in navigator) {
      try {
        navigator.mediaSession.setActionHandler("play", null);
        navigator.mediaSession.setActionHandler("pause", null);
        navigator.mediaSession.metadata = null;
      } catch {}
    }
    state.radioUrl = "";
    state.radioTitle = "";
    clearInterval(state.nowPlayingTimer);
    return;
  }
  const changed = state.radioUrl !== radio.stream_url;
  if (changed && radioAudio) {
    radioAudio.pause();
    radioAudio.removeAttribute("src");
    radioAudio.load();
  }
  state.radioUrl = radio.stream_url;
  state.radioTitle = radio.title || "رادیو";
  if (!radioAudio) {
    radioAudio = document.createElement("audio");
    radioAudio.preload = "none";
    radioAudio.volume = 0.8;
    try {
      const volume = Number(localStorage.getItem("pnu.radioVolume"));
      if (volume >= 0 && volume <= 1) radioAudio.volume = volume;
    } catch {}
    radioAudio.addEventListener("play", () => {
      const button = radioRoot.querySelector(".radio-play");
      if (button) {
        button.innerHTML = '<svg class="icon"><use href="#icon-pause"/></svg>';
        button.setAttribute("aria-label", "توقف رادیو");
      }
    });
    radioAudio.addEventListener("pause", () => {
      const button = radioRoot.querySelector(".radio-play");
      if (button) {
        button.innerHTML = '<svg class="icon"><use href="#icon-play"/></svg>';
        button.setAttribute("aria-label", "پخش رادیو");
      }
    });
    radioAudio.addEventListener("error", () =>
      showToast("پخش رادیو در دسترس نیست."),
    );
  }
  if (!radioRoot.querySelector(".radio-bar")) {
    radioRoot.innerHTML = `<section class="radio-bar" aria-label="پخش رادیوی دانشگاه">
      <button class="audio-button radio-play" type="button" aria-label="پخش رادیو"><svg class="icon"><use href="#icon-play"/></svg></button>
      <div class="radio-info"><strong class="radio-title"></strong><span class="radio-now-playing">پخش زندهٔ رادیو</span></div>
      <label class="volume-control" aria-label="بلندی صدا"><svg class="icon"><use href="#icon-volume"/></svg><input class="radio-volume" type="range" min="0" max="1" step="0.05" aria-label="بلندی صدا"></label>
    </section>`;
    radioRoot.querySelector(".radio-volume").value = String(radioAudio.volume);
  }
  radioRoot.querySelector(".radio-title").textContent = state.radioTitle;
  setMediaMetadata(state.radioTitle, "رادیوی اینترنتی");
  clearInterval(state.nowPlayingTimer);
  refreshNowPlaying();
  state.nowPlayingTimer = setInterval(refreshNowPlaying, 20_000);
}

function initRadioEvents() {
  radioRoot.addEventListener("click", async (event) => {
    const button = event.target.closest(".radio-play");
    if (!button || !state.radioUrl || !radioAudio) return;
    if (!radioAudio.paused) {
      radioAudio.pause();
      return;
    }
    await playRadio();
  });
  radioRoot.addEventListener("input", (event) => {
    if (!event.target.matches(".radio-volume") || !radioAudio) return;
    radioAudio.volume = Number(event.target.value);
    try {
      localStorage.setItem("pnu.radioVolume", String(radioAudio.volume));
    } catch {}
  });
}

async function refreshConfig() {
  try {
    const nextConfig = await getJson("/api/public/config");
    const regionsChanged =
      JSON.stringify(nextConfig.provinces) !==
      JSON.stringify(state.config?.provinces);
    state.config = nextConfig;
    const currentNewsTitle = state.newsId
      ? document.querySelector("#news-view h1")?.textContent
      : null;
    document.title = currentNewsTitle
      ? `${currentNewsTitle} — ${nextConfig.site_title || "اخبار پیام نور"}`
      : nextConfig.site_title || "اخبار پیام نور";
    document.getElementById("site-title").textContent =
      nextConfig.site_title || "اخبار پیام نور";
    const selected = state.city ? findCity(state.city.id) : null;
    if (state.city && !selected) {
      state.city = null;
      state.province = null;
      try {
        localStorage.removeItem("pnu.city");
      } catch {}
      updateSelectedCity();
      resetFeed();
      feedMessage.textContent =
        "شهرستان قبلی دیگر در دسترس نیست؛ لطفاً شهرستان دیگری انتخاب کنید.";
      openPicker();
    } else if (selected) {
      state.city = selected.city;
      state.province = selected.province;
      updateSelectedCity();
    }
    renderRadio(nextConfig.radio);
    if (state.city && feed.childElementCount === 0 && !state.loading)
      resetFeed();
    if (regionsChanged) {
      if (state.pickerProvince)
        state.pickerProvince =
          nextConfig.provinces.find(
            (item) => Number(item.id) === Number(state.pickerProvince.id),
          ) ?? null;
      if (picker.open) renderPickerList();
    }
  } catch (error) {
    if (!state.config)
      feedMessage.textContent =
        "ارتباط با سرور برقرار نشد. پس از اتصال دوباره تلاش کنید.";
  }
}

async function initializeReader({ newsOnly = false } = {}) {
  initTheme();
  initFontScale();
  initRadioEvents();
  intersectionObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMore();
    },
    { rootMargin: "700px 0px" },
  );
  intersectionObserver.observe(sentinel);
  try {
    const config = await getJson("/api/public/config");
    state.config = config;
    document.title = config.site_title || "اخبار پیام نور";
    document.getElementById("site-title").textContent =
      config.site_title || "اخبار پیام نور";
    if (newsOnly) {
      app.hidden = true;
      newsView.hidden = false;
    } else {
      const savedCityId = (() => {
        try {
          return localStorage.getItem("pnu.city");
        } catch {
          return null;
        }
      })();
      const selected = savedCityId ? findCity(savedCityId) : null;
      if (selected) {
        state.city = selected.city;
        state.province = selected.province;
        updateSelectedCity();
        resetFeed();
      } else {
        if (savedCityId) {
          try {
            localStorage.removeItem("pnu.city");
          } catch {}
        }
        updateSelectedCity();
        resetFeed();
        openPicker();
      }
    }
    renderRadio(config.radio);
  } catch {
    feedMessage.textContent =
      "ارتباط با سرور برقرار نشد. صفحه را دوباره بارگذاری کنید.";
  }
  state.refreshTimer = setInterval(refreshConfig, 15_000);
  setInterval(checkForNewItems, 60_000);
}

async function loadNewsPage(id, { initial = false } = {}) {
  if (!initial) {
    app.hidden = true;
    newsView.hidden = false;
    intersectionObserver?.unobserve(sentinel);
  }
  state.newsId = Number(id);
  if (!initial)
    newsView.innerHTML =
      '<div class="news-page"><div class="news-skeleton" aria-hidden="true"></div></div>';
  try {
    const { item } = await getJson(`/api/public/news/${id}`);
    state.newsId = Number(item.id);
    const target = initial ? app : newsView;
    target.innerHTML = renderNewsPage(item, initial);
    target.hidden = false;
    if (!initial) app.hidden = true;
    document.title = `${item.title} — ${state.config?.site_title || "اخبار پیام نور"}`;
    if ("mediaSession" in navigator)
      setMediaMetadata(item.title, item.publisher_unit);
  } catch (error) {
    const target = initial ? app : newsView;
    target.innerHTML = `<section class="reader-error"><h1>خبر پیدا نشد</h1><p>${escapeHtml(error.message)}</p><a class="news-back" href="/">بازگشت به خبرها</a></section>`;
    target.hidden = false;
  }
}

function renderNewsPage(item, initial) {
  const signatureParts = [
    item.publisher_name
      ? `<strong>${escapeHtml(item.publisher_name)}</strong>`
      : "",
    item.publisher_unit ? escapeHtml(item.publisher_unit) : "",
  ].filter(Boolean);
  const signature = signatureParts.length
    ? `<p class="news-signature">${signatureParts.join(" — ")}</p>`
    : "";
  const category = item.category?.name
    ? `<span>${escapeHtml(item.category.name)}</span>`
    : "";
  const date = new Date(item.published_at);
  const fullDate = `${dateFormatter.format(date)} — ${timeFormatter.format(date)}`;
  const cover = item.cover?.src
    ? `<div class="news-page-cover-frame">${placeholderMarkup(item.cover.dominant_color)}<img class="news-page-cover" src="${escapeHtml(item.cover.src)}" srcset="${escapeHtml(item.cover.srcset ?? "")}" sizes="(max-width: 790px) 100vw, 790px" width="${Number(item.cover.width) || 1280}" height="${Number(item.cover.height) || 720}" fetchpriority="high" alt="${escapeHtml(item.title)}"></div>`
    : "";
  const gallery = (item.images ?? [])
    .filter((image) => image.src && Number(image.id) !== Number(item.cover?.id))
    .map(
      (image) =>
        `<div class="gallery-image-frame">${placeholderMarkup(image.dominant_color)}<img src="${escapeHtml(image.src)}" srcset="${escapeHtml(image.srcset ?? "")}" sizes="(max-width: 767px) 100vw, 50vw" width="${Number(image.width) || 800}" height="${Number(image.height) || 600}" loading="lazy" decoding="async" alt="${escapeHtml(image.original_name)}"></div>`,
    )
    .join("");
  const files = (item.files ?? [])
    .map(
      (file) =>
        `<a class="attachment-link" href="${escapeHtml(file.url)}"><span>▤ ${escapeHtml(file.original_name)}</span><span>${escapeHtml(formatBytes(file.size_bytes))}</span></a>`,
    )
    .join("");
  return `${initial ? "" : '<a class="news-back" href="/" data-reader-back><svg class="icon"><use href="#icon-chevron"/></svg>بازگشت به خبرها</a>'}
    <article class="news-page">${cover}<h1>${escapeHtml(item.title)}</h1>
    <div class="news-details">${category}<time datetime="${escapeHtml(item.published_at)}">${fullDate}</time><span>${digits.format(item.view_count)} بازدید</span></div>
    <div class="news-body">${item.body_html}</div>
    ${signature}
    ${gallery ? `<section class="news-gallery" aria-label="تصاویر خبر">${gallery}</section>` : ""}
    ${files ? `<section class="attachment-list"><h2>پیوست‌ها</h2>${files}</section>` : ""}
    <div class="news-actions"><button type="button" class="share-button" data-share><svg class="icon"><use href="#icon-share"/></svg>اشتراک‌گذاری خبر</button></div>
    </article>`;
}

function formatBytes(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${digits.format(size)} بایت`;
  if (size < 1024 * 1024)
    return `${digits.format((size / 1024).toFixed(1))} کیلوبایت`;
  return `${digits.format((size / (1024 * 1024)).toFixed(1))} مگابایت`;
}

async function shareCurrentNews() {
  const url = location.href;
  const title =
    document.querySelector("#news-view h1, #app h1")?.textContent ||
    document.title;
  try {
    if (navigator.share) await navigator.share({ title, url });
    else if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      showToast("پیوند خبر کپی شد.");
    } else {
      const input = document.createElement("textarea");
      input.value = url;
      input.setAttribute("readonly", "");
      input.className = "copy-fallback";
      document.body.append(input);
      input.select();
      document.execCommand("copy");
      input.remove();
      showToast("پیوند خبر کپی شد.");
    }
  } catch (error) {
    if (error.name !== "AbortError") showToast("اشتراک‌گذاری انجام نشد.");
  }
}

function navigateToNews(id) {
  history.replaceState(
    { ...(history.state ?? {}), readerScrollY: window.scrollY },
    "",
    location.href,
  );
  history.pushState(
    { readerEntry: true, readerScrollY: window.scrollY },
    "",
    `/n/${id}`,
  );
  loadNewsPage(id);
  window.scrollTo(0, 0);
}

function returnToFeed() {
  state.newsId = null;
  document.title = state.config?.site_title || "اخبار پیام نور";
  newsView.hidden = true;
  app.hidden = false;
  intersectionObserver?.observe(sentinel);
  const scrollY = Number(history.state?.readerScrollY) || 0;
  requestAnimationFrame(() => window.scrollTo(0, scrollY));
}

// ---------- Service worker & install suggestion ----------
const INSTALL_SNOOZE_KEY = "pnu.installDismissedAt";
const INSTALL_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;
let deferredInstall = null;

function isStandalone() {
  return (
    matchMedia("(display-mode: standalone)").matches ||
    navigator.standalone === true
  );
}

function installSnoozed() {
  try {
    const at = Number(localStorage.getItem(INSTALL_SNOOZE_KEY));
    return Boolean(at) && Date.now() - at < INSTALL_SNOOZE_MS;
  } catch {
    return false;
  }
}

function snoozeInstall() {
  try {
    localStorage.setItem(INSTALL_SNOOZE_KEY, String(Date.now()));
  } catch {}
}

function isIosSafari() {
  const ua = navigator.userAgent;
  const ios =
    /iphone|ipad|ipod/i.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return ios && /safari/i.test(ua) && !/crios|fxios|edgios|opios/i.test(ua);
}

function hideInstallBanner() {
  installRoot?.replaceChildren();
}

function showInstallBanner(mode) {
  if (
    !installRoot ||
    installRoot.childElementCount ||
    isStandalone() ||
    installSnoozed()
  )
    return;
  const text =
    mode === "ios"
      ? "در Safari روی دکمهٔ اشتراک‌گذاری و سپس «افزودن به صفحهٔ اصلی» بزنید."
      : "برای دسترسی سریع‌تر، برنامه را روی دستگاه خود نصب کنید.";
  const action =
    mode === "ios"
      ? ""
      : '<button type="button" class="button-primary" data-install-accept>نصب</button>';
  installRoot.innerHTML = `<div class="install-banner" role="region" aria-label="نصب برنامه"><img src="/icons/pnu-icon-192.v1.png" width="40" height="40" alt="" aria-hidden="true"><div class="install-text"><strong>نصب اخبار پیام نور</strong><span>${text}</span></div>${action}<button type="button" class="icon-button" data-install-dismiss aria-label="بستن"><svg class="icon"><use href="#icon-close"/></svg></button></div>`;
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () =>
    navigator.serviceWorker.register("/sw.js").catch(() => {}),
  );
}
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstall = event;
  setTimeout(() => {
    if (deferredInstall) showInstallBanner("prompt");
  }, 6000);
});
window.addEventListener("appinstalled", () => {
  deferredInstall = null;
  hideInstallBanner();
});
if (isIosSafari() && !isStandalone())
  setTimeout(() => showInstallBanner("ios"), 8000);
installRoot?.addEventListener("click", async (event) => {
  if (event.target.closest("[data-install-dismiss]")) {
    snoozeInstall();
    hideInstallBanner();
    return;
  }
  if (!event.target.closest("[data-install-accept]") || !deferredInstall)
    return;
  const promptEvent = deferredInstall;
  deferredInstall = null;
  hideInstallBanner();
  try {
    await promptEvent.prompt();
    const { outcome } = await promptEvent.userChoice;
    if (outcome !== "accepted") snoozeInstall();
  } catch {}
});

document.getElementById("city-button").addEventListener("click", openPicker);
document.addEventListener(
  "error",
  (event) => {
    if (
      !(event.target instanceof HTMLImageElement) ||
      event.target.classList.contains("cover-placeholder")
    )
      return;
    if (
      event.target.classList.contains("card-cover") ||
      event.target.classList.contains("news-page-cover") ||
      event.target.closest(".gallery-image-frame,.pinned-cover-frame")
    )
      event.target.hidden = true;
  },
  true,
);
document
  .querySelector(".picker-close")
  .addEventListener("click", () => picker.close());
picker.addEventListener("click", (event) => {
  if (event.target === picker) {
    picker.close();
    return;
  }
  const provinceButton = event.target.closest("[data-province-id]");
  if (provinceButton) {
    state.pickerProvince =
      state.config.provinces.find(
        (province) =>
          Number(province.id) === Number(provinceButton.dataset.provinceId),
      ) ?? null;
    pickerSearch.value = "";
    renderPickerList();
    pickerList.scrollTop = 0;
    focusPickerSearch();
    return;
  }
  const cityButton = event.target.closest("[data-city-id]");
  if (cityButton) {
    const found = findCity(cityButton.dataset.cityId);
    if (found) setCity(found.city, found.province);
  }
});
pickerBack.addEventListener("click", () => {
  state.pickerProvince = null;
  pickerSearch.value = "";
  renderPickerList();
  pickerList.scrollTop = 0;
  focusPickerSearch();
});
pickerSearch.addEventListener("input", renderPickerList);
feed.addEventListener("click", (event) => {
  if (event.target.closest("[data-open-picker]")) {
    openPicker();
    return;
  }
  const card = event.target.closest("[data-news-id]");
  if (card) navigateToNews(card.dataset.newsId);
});
pinnedStrip.addEventListener("click", (event) => {
  const card = event.target.closest("[data-news-id]");
  if (card) navigateToNews(card.dataset.newsId);
});
feed.addEventListener("keydown", (event) => {
  if (
    (event.key === "Enter" || event.key === " ") &&
    event.target.matches("[data-news-id]")
  ) {
    event.preventDefault();
    navigateToNews(event.target.dataset.newsId);
  }
});
pinnedStrip.addEventListener("keydown", (event) => {
  if (
    (event.key === "Enter" || event.key === " ") &&
    event.target.matches("[data-news-id]")
  ) {
    event.preventDefault();
    navigateToNews(event.target.dataset.newsId);
  }
});
newItemsBanner.addEventListener("click", () => resetFeed({ scroll: true }));
app.addEventListener("click", (event) => {
  if (event.target.closest("[data-share]")) shareCurrentNews();
});
newsView.addEventListener("click", (event) => {
  if (event.target.closest("[data-share]")) shareCurrentNews();
  if (event.target.closest("[data-reader-back]")) {
    event.preventDefault();
    if (history.state?.readerEntry) history.back();
    else location.assign("/");
  }
});
window.addEventListener("popstate", () => {
  const match = /^\/n\/(\d+)$/.exec(location.pathname);
  if (match) loadNewsPage(match[1]);
  else if (state.newsId) returnToFeed();
});

const initialNewsMatch = /^\/n\/(\d+)$/.exec(location.pathname);
if (initialNewsMatch) {
  initializeReader({ newsOnly: true }).then(() =>
    loadNewsPage(initialNewsMatch[1]),
  );
} else {
  initializeReader();
}
