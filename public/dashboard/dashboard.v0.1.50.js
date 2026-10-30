import { initRichEditor } from "/shared/rich-editor.v0.1.50.js";
import {
  JALALI_MONTHS,
  jalaliMonthLength,
  jalaliToGregorian,
} from "/shared/jalali.v1.js";

const authRoot = document.getElementById("auth-root");
const adminShell = document.getElementById("admin-shell");
const state = {
  user: null,
  regions: [],
  categories: [],
  settings: {},
  currentNews: null,
  newsPage: 1,
  auditPage: 1,
  mobilePages: { mine: 1, all: 1 },
  usersPage: 1,
  newsDates: { published_at: null, expires_at: null },
  calendar: {
    year: 0,
    month: 0,
    day: 0,
    hour: 12,
    minute: 0,
    target: "published_at",
  },
  toastTimer: null,
  activeView: "",
  busy: false,
  units: { items: [], open: new Set(), editing: null },
  categoryAdmin: { items: [], editing: null },
  uploads: { cover: [], images: [], files: [] },
  uploadSeq: 0,
};
const faCollator = new Intl.Collator("fa", { sensitivity: "base" });
const faDigits = new Intl.NumberFormat("fa-IR");
const dateDisplay = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
  timeZone: "Asia/Tehran",
  day: "numeric",
  month: "long",
  year: "numeric",
});
const dateTimeDisplay = new Intl.DateTimeFormat("fa-IR", {
  timeZone: "Asia/Tehran",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const weekdayNames = [
  "شنبه",
  "یکشنبه",
  "دوشنبه",
  "سه‌شنبه",
  "چهارشنبه",
  "پنجشنبه",
  "جمعه",
];

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

function normalizeDigits(value) {
  return String(value ?? "").replace(/[۰-۹٠-٩]/g, (digit) => {
    const index = "۰۱۲۳۴۵۶۷۸۹".indexOf(digit);
    return String(index >= 0 ? index : "٠١٢٣٤٥٦٧٨٩".indexOf(digit));
  });
}

function showToast(message) {
  const toast = document.getElementById("admin-toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove("visible"), 2800);
}

function showMessage(title, message, secret = "") {
  const dialog = document.getElementById("message-dialog");
  const content = document.getElementById("message-content");
  content.innerHTML = `<p class="eyebrow">اطلاع‌رسانی</p><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p>${secret ? `<div class="temp-secret"><code dir="ltr">${escapeHtml(secret)}</code><button class="button outline" type="button" data-copy-secret>کپی</button></div>` : ""}`;
  dialog.showModal();
}

// ---------- Installable web app ----------
// The dashboard has its own manifest (scope /dashboard/) and service worker, so it installs as a separate app.
// Like the reader it suggests the installation with a floating card, and a newly published version waits behind an
// "update" card until the user accepts it (the service worker never activates by itself).
const INSTALL_SNOOZE_KEY = "pnu.dashboard.installDismissedAt";
const INSTALL_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;
const installRoot = document.getElementById("install-root");
const updateRoot = document.getElementById("update-root");
const installButton = document.getElementById("install-button");
let installPrompt = null;
let waitingWorker = null;
let swRegistration = null;
let controlled = Boolean(navigator.serviceWorker?.controller);

const isStandalone = () =>
  matchMedia("(display-mode: standalone)").matches ||
  navigator.standalone === true;
const isIos = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

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
// Adding ?install=1 to the address shows the suggestion again (ignores a previous dismissal), for testing.
const forceInstallHint = new URLSearchParams(location.search).has("install");
const hideInstallBanner = () => installRoot?.replaceChildren();

function showInstallBanner(mode) {
  if (
    !installRoot ||
    installRoot.childElementCount ||
    isStandalone() ||
    (installSnoozed() && !forceInstallHint)
  )
    return;
  const text =
    mode === "ios"
      ? "روی دکمهٔ اشتراک‌گذاری (مربع با فلش) بزنید و «افزودن به صفحهٔ اصلی» را انتخاب کنید."
      : "برای دسترسی سریع‌تر، پنل مدیریت را روی دستگاه خود نصب کنید.";
  const action =
    mode === "ios"
      ? ""
      : '<button type="button" class="button primary" data-install-accept>نصب</button>';
  installRoot.innerHTML = `<div class="install-banner" role="region" aria-label="نصب برنامه"><img src="/icons/pnu-logo.v3.png" width="40" height="40" alt="" aria-hidden="true"><div class="install-text"><strong>نصب مدیریت خبرهای پیام‌نور</strong><span>${text}</span></div>${action}<button type="button" class="icon-button" data-install-dismiss aria-label="بستن"><svg class="icon"><use href="#admin-icon-close"/></svg></button></div>`;
}

function showUpdateBanner(worker) {
  waitingWorker = worker; // always track the newest waiting worker, even while the card is already open
  if (!updateRoot || updateRoot.childElementCount) return;
  updateRoot.innerHTML =
    '<div class="install-banner" role="status"><img src="/icons/pnu-logo.v3.png" width="40" height="40" alt="" aria-hidden="true"><div class="install-text"><strong>نسخهٔ جدید آماده است</strong><span>برای دریافت آخرین تغییرات، برنامه را به‌روزرسانی کنید.</span></div><button type="button" class="button primary" data-update-accept>به‌روزرسانی</button><button type="button" class="icon-button" data-update-dismiss aria-label="بعداً"><svg class="icon"><use href="#admin-icon-close"/></svg></button></div>';
}

// Every open window of the app follows an update: the one that applies it tells the others, and they reload.
const updateChannel =
  "BroadcastChannel" in window
    ? new BroadcastChannel("pnu-dashboard-update")
    : null;
let reloadingForUpdate = false;
let reloadPending = false;
function reloadForUpdate() {
  if (reloadingForUpdate) return;
  reloadingForUpdate = true;
  location.reload();
}
updateChannel?.addEventListener("message", (event) => {
  if (event.data?.type !== "reload") return;
  reloadPending = true;
  reloadForUpdate();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && reloadPending) {
    reloadingForUpdate = false;
    reloadForUpdate();
  }
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!controlled) {
      controlled = true;
      return;
    } // first install taking control: nothing to reload
    reloadPending = true;
    updateChannel?.postMessage({ type: "reload" });
    reloadForUpdate();
  });
  const registerWorker = async () => {
    try {
      const registration = await navigator.serviceWorker.register(
        "/dashboard/sw.js",
        { scope: "/dashboard/" },
      );
      swRegistration = registration;
      const announce = (worker) =>
        worker.addEventListener("statechange", () => {
          if (
            worker.state === "installed" &&
            navigator.serviceWorker.controller
          )
            showUpdateBanner(worker);
        });
      if (registration.waiting && navigator.serviceWorker.controller)
        showUpdateBanner(registration.waiting);
      if (registration.installing) announce(registration.installing);
      registration.addEventListener(
        "updatefound",
        () => registration.installing && announce(registration.installing),
      );
      // A published version is noticed when the app is opened again and every hour while it stays open.
      const check = () => registration.update().catch(() => {});
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) check();
      });
      setInterval(check, 60 * 60 * 1000);
    } catch {}
  };
  if (document.readyState === "complete") registerWorker();
  else window.addEventListener("load", registerWorker, { once: true });
}

updateRoot?.addEventListener("click", (event) => {
  if (event.target.closest("[data-update-dismiss]")) {
    updateRoot.replaceChildren();
    return;
  }
  const accept = event.target.closest("[data-update-accept]");
  const worker = swRegistration?.waiting ?? waitingWorker; // a newer release may have replaced the one the card opened for
  if (!accept || !worker) return;
  accept.disabled = true;
  accept.textContent = "در حال به‌روزرسانی…";
  worker.postMessage({ type: "SKIP_WAITING" });
  setTimeout(() => {
    updateChannel?.postMessage({ type: "reload" });
    reloadForUpdate();
  }, 4000); // safety net
});

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  installButton.hidden = false;
  setTimeout(() => {
    if (installPrompt) showInstallBanner("prompt");
  }, 3000);
});
window.addEventListener("appinstalled", () => {
  installPrompt = null;
  installButton.hidden = true;
  hideInstallBanner();
});
if (isIos() && !isStandalone())
  setTimeout(() => showInstallBanner("ios"), 4000);

async function runInstall() {
  if (!installPrompt) return;
  const promptEvent = installPrompt;
  installPrompt = null;
  installButton.hidden = true;
  hideInstallBanner();
  try {
    await promptEvent.prompt();
    const { outcome } = await promptEvent.userChoice;
    if (outcome !== "accepted") snoozeInstall();
  } catch {}
}
installButton.addEventListener("click", runInstall);
installRoot?.addEventListener("click", (event) => {
  if (event.target.closest("[data-install-dismiss]")) {
    snoozeInstall();
    hideInstallBanner();
    return;
  }
  if (event.target.closest("[data-install-accept]")) runInstall();
});

// ---------- About dialog ----------
const aboutDialog = document.getElementById("about-dialog");
document.getElementById("about-button").addEventListener("click", () => {
  const version = /dashboard\.v([\d.]+)\.js/.exec(import.meta.url)?.[1] ?? "";
  document.getElementById("about-version").textContent = version.replace(
    /\d/g,
    (digit) => "۰۱۲۳۴۵۶۷۸۹"[digit],
  );
  aboutDialog.showModal();
});
aboutDialog.addEventListener("click", (event) => {
  if (
    event.target === aboutDialog ||
    event.target.closest("[data-dialog-close]")
  )
    aboutDialog.close();
});
// Opens the chat in the Telegram app when it is installed, otherwise the web page (t.me) opens in a new tab.
document.getElementById("about-telegram").addEventListener("click", (event) => {
  event.preventDefault();
  const webUrl = event.currentTarget.href;
  let left = false;
  const markLeft = () => {
    left = true;
  };
  window.addEventListener("blur", markLeft, { once: true });
  document.addEventListener("visibilitychange", markLeft, { once: true });
  location.href = "tg://resolve?domain=RealDream";
  setTimeout(() => {
    window.removeEventListener("blur", markLeft);
    document.removeEventListener("visibilitychange", markLeft);
    if (!left) window.open(webUrl, "_blank", "noopener,noreferrer");
  }, 1600);
});

// SweetAlert-style dialogs (no external library; the CSP only allows our own files).
function askDialog({
  title,
  text = "",
  tone = "warning",
  confirmText = "تأیید",
  cancelText = "انصراف",
  input = null,
}) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "swal-dialog";
    dialog.setAttribute("aria-labelledby", "swal-title");
    const symbol = tone === "question" ? "؟" : "!";
    dialog.innerHTML =
      `<div class="swal-panel"><div class="swal-icon ${tone}" aria-hidden="true">${symbol}</div>` +
      `<h2 id="swal-title" class="swal-title">${escapeHtml(title)}</h2>` +
      (text ? `<p class="swal-text">${escapeHtml(text)}</p>` : "") +
      (input
        ? `<input class="swal-input" type="${input.type || "text"}" dir="${input.dir || "rtl"}" placeholder="${escapeHtml(input.placeholder || "")}" autocomplete="off">`
        : "") +
      `<div class="swal-actions"><button type="button" class="button ${tone === "danger" ? "danger" : "primary"}" data-swal="confirm">${escapeHtml(confirmText)}</button>` +
      `<button type="button" class="button outline" data-swal="cancel">${escapeHtml(cancelText)}</button></div></div>`;
    const field = dialog.querySelector(".swal-input");
    let result = null;
    const finish = (value) => {
      result = value;
      dialog.close();
    };
    dialog.addEventListener("click", (event) => {
      const action = event.target.closest("[data-swal]")?.dataset.swal;
      if (action === "confirm") finish(field ? field.value.trim() : true);
      else if (action === "cancel" || event.target === dialog)
        finish(field ? null : false);
    });
    if (field)
      field.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          finish(field.value.trim());
        }
      });
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(result ?? (field ? null : false));
    });
    document.body.append(dialog);
    dialog.showModal();
    (
      field ||
      dialog.querySelector(
        tone === "danger" ? '[data-swal="cancel"]' : '[data-swal="confirm"]',
      )
    ).focus();
  });
}

const confirmDialog = (options) => askDialog(options);
const promptDialog = (options) =>
  askDialog({ tone: "question", confirmText: "افزودن", ...options });

async function api(path, { method = "GET", body, formData } = {}) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers,
    body: formData ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok) {
    if (response.status === 401 && !authRoot.hidden) showAuth("login-card");
    throw new Error(payload.error || "انجام درخواست ناموفق بود.");
  }
  return payload;
}

function showAuth(sectionId) {
  adminShell.hidden = true;
  authRoot.hidden = false;
  authRoot.querySelectorAll(":scope > section").forEach((section) => {
    section.hidden = section.id !== sectionId;
  });
}

function closeAuthAndShowAdmin() {
  authRoot.hidden = true;
  adminShell.hidden = false;
}

function roleLabel(role) {
  return (
    {
      super_admin: "مدیر ارشد",
      country_admin: "روابط عمومی سازمان مرکزی",
      province_admin: "مدیر استان",
      city_admin: "مدیر مرکز دانشگاهی",
    }[role] || "مدیر"
  );
}

function regionName(regionId) {
  return (
    state.regions.find((region) => Number(region.id) === Number(regionId))
      ?.name || ""
  );
}

function scopeText() {
  const region = state.regions.find(
    (item) => Number(item.id) === Number(state.user?.region_id),
  );
  if (state.user?.role === "super_admin")
    return "شما برای کل کشور منتشر می‌کنید.";
  if (state.user?.role === "country_admin")
    return "شما برای کل کشور و استان‌ها منتشر می‌کنید.";
  if (region?.type === "province")
    return `شما برای استان ${region.name} و مراکز دانشگاهی آن منتشر می‌کنید.`;
  return `شما برای دانشگاه پیام‌نور ${region?.name || "خود"} منتشر می‌کنید.`;
}

function setScopeBanner() {
  const text = scopeText();
  document.getElementById("scope-banner").textContent = text;
  document.getElementById("desktop-scope").textContent = text;
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return `${dateDisplay.format(date)} — ${dateTimeDisplay.format(date)}`;
}

function statusLabel(status) {
  return (
    { draft: "پیش‌نویس", scheduled: "زمان‌بندی‌شده", published: "منتشرشده" }[
      status
    ] || status
  );
}

function scopeLabel(targets = []) {
  if (!targets.length) return "بدون مقصد";
  return targets
    .map((target) =>
      target.type === "country"
        ? "سراسری"
        : target.type === "province"
          ? `استان ${target.name}`
          : `دانشگاه پیام‌نور ${target.name}`,
    )
    .join("، ");
}

function displayDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat("en-US-u-ca-persian-nu-latn", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  const valueOf = (key) =>
    Number(parts.find((part) => part.type === key)?.value);
  const clock = new Intl.DateTimeFormat("en-US-u-nu-latn", {
    timeZone: "Asia/Tehran",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
  return {
    year: valueOf("year"),
    month: valueOf("month"),
    day: valueOf("day"),
    hour: Number(clock.slice(0, 2)),
    minute: Number(clock.slice(-2)),
  };
}

function currentIranJalali() {
  const parts = new Intl.DateTimeFormat("en-US-u-ca-persian-nu-latn", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(new Date());
  return {
    year: Number(parts.find((part) => part.type === "year").value),
    month: Number(parts.find((part) => part.type === "month").value),
    day: Number(parts.find((part) => part.type === "day").value),
    hour: Number(
      new Intl.DateTimeFormat("en-US-u-nu-latn", {
        timeZone: "Asia/Tehran",
        hour: "2-digit",
        hourCycle: "h23",
      }).format(new Date()),
    ),
    minute: Number(
      new Intl.DateTimeFormat("en-US-u-nu-latn", {
        timeZone: "Asia/Tehran",
        minute: "2-digit",
      }).format(new Date()),
    ),
  };
}

function showCalendar(target) {
  state.calendar.target = target;
  const selected =
    displayDateTime(state.newsDates[target]) || currentIranJalali();
  state.calendar = { ...selected, target };
  document.getElementById("jalali-title").textContent =
    target === "published_at" ? "انتخاب زمان انتشار" : "انتخاب زمان انقضا";
  document.getElementById("jalali-hour").value = String(
    state.calendar.hour,
  ).padStart(2, "0");
  document.getElementById("jalali-minute").value = String(
    state.calendar.minute,
  ).padStart(2, "0");
  renderCalendar();
  document.getElementById("jalali-dialog").showModal();
}

function renderCalendar() {
  const { year, month, day } = state.calendar;
  document.getElementById("jalali-month-label").textContent =
    `${JALALI_MONTHS[month - 1]} ${faDigits.format(year)}`;
  document.getElementById("jalali-weekdays").innerHTML = weekdayNames
    .map((name) => `<span class="calendar-weekday">${name}</span>`)
    .join("");
  const firstGregorian = jalaliToGregorian(year, month, 1);
  const weekOffset =
    (new Date(
      Date.UTC(
        firstGregorian.year,
        firstGregorian.month - 1,
        firstGregorian.day,
      ),
    ).getUTCDay() +
      1) %
    7;
  const days = [];
  for (let index = 0; index < weekOffset; index += 1)
    days.push('<span class="calendar-day empty"></span>');
  for (
    let currentDay = 1;
    currentDay <= jalaliMonthLength(year, month);
    currentDay += 1
  ) {
    const weekday = (weekOffset + currentDay - 1) % 7;
    const selected = currentDay === day ? " selected" : "";
    const friday = weekday === 6 ? " friday" : "";
    days.push(
      `<button type="button" class="calendar-day${selected}${friday}" data-calendar-day="${currentDay}" aria-pressed="${currentDay === day}">${faDigits.format(currentDay)}</button>`,
    );
  }
  document.getElementById("jalali-days").innerHTML = days.join("");
}

function updateDateLabel(field) {
  const input = document.querySelector(`[name="${field}_display"]`);
  const value = state.newsDates[field];
  if (!value) {
    input.value = "";
    return;
  }
  const date = new Date(value);
  input.value = `${dateDisplay.format(date)} — ${dateTimeDisplay.format(date)}`;
}

function applyCalendarDate() {
  const { year, month, day, target } = state.calendar;
  const hourText = normalizeDigits(
    document.getElementById("jalali-hour").value,
  );
  const minuteText = normalizeDigits(
    document.getElementById("jalali-minute").value,
  );
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (
    !Number.isInteger(hour) ||
    hour < 0 ||
    hour > 23 ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59
  ) {
    showToast("ساعت یا دقیقه معتبر نیست.");
    return;
  }
  const gregorian = jalaliToGregorian(year, month, day);
  const utcMilliseconds =
    Date.UTC(gregorian.year, gregorian.month - 1, gregorian.day, hour, minute) -
    210 * 60_000;
  state.newsDates[target] = new Date(utcMilliseconds).toISOString();
  updateDateLabel(target);
  document.getElementById("jalali-dialog").close();
}

const FEED_ROLES = ["super_admin", "country_admin"];

function goToView(view) {
  // A city-level admin has no subordinates, so there is nothing to manage on the users page.
  if (view === "users" && state.user?.role === "city_admin") view = "dashboard";
  // The news feed is only for the main admin and the central organisation's public relations.
  const mobile = matchMedia("(max-width: 767px)").matches;
  if (view === "mobile-feed" && !FEED_ROLES.includes(state.user?.role))
    view = mobile ? "mobile-compose" : "dashboard";
  const actualView =
    mobile &&
    !view.startsWith("mobile-") &&
    view !== "profile" &&
    view !== "editor"
      ? "mobile-compose"
      : view;
  document.querySelectorAll(".admin-view").forEach((panel) => {
    panel.hidden = panel.dataset.panel !== actualView;
  });
  document
    .querySelectorAll("#desktop-nav [data-view]")
    .forEach((button) =>
      button.setAttribute(
        "aria-current",
        String(button.dataset.view === actualView),
      ),
    );
  document
    .querySelectorAll("#mobile-nav [data-view]")
    .forEach((button) =>
      button.classList.toggle("active", button.dataset.view === actualView),
    );
  state.activeView = actualView;
  if (actualView === "dashboard") loadDashboard();
  else if (actualView === "news") loadNewsList(1);
  else if (actualView === "users") loadUsers(1);
  else if (actualView === "regions") loadRegions();
  else if (actualView === "categories") loadCategories();
  else if (actualView === "settings") loadSettings();
  else if (actualView === "audit") loadAudit(1);
  else if (actualView === "stats") loadStats();
  else if (actualView === "mobile-recent") loadMobileNews("mine", 1);
  else if (actualView === "mobile-feed") loadMobileNews("all", 1);
  else if (actualView === "profile") loadProfile();
  if (actualView === "mobile-compose") renderQuickPreview();
  document
    .querySelector(".admin-content")
    .scrollIntoView({ block: "start", behavior: "auto" });
}

async function loadAdmin() {
  try {
    const me = await api("/api/auth/me");
    state.user = me.user;
    if (me.user.must_change_password) {
      showAuth("password-card");
      return;
    }
    closeAuthAndShowAdmin();
    await prepareWorkspace();
  } catch {
    showAuth("login-card");
  }
}

// The username chip scrolls sideways on phones when the name is long. Touch, pen and mouse all drag it (JS)
// and the wheel scrolls it; the edge fade tells the user there is more text on that side.
function setupUserChip(chip) {
  const refresh = () => {
    const max = chip.scrollWidth - chip.clientWidth;
    const rtl = getComputedStyle(chip).direction === "rtl";
    const pos = Math.abs(chip.scrollLeft);
    const hiddenLeft = max > 1 && (rtl ? pos < max - 1 : pos > 1);
    const hiddenRight = max > 1 && (rtl ? pos > 1 : pos < max - 1);
    chip.classList.toggle("fade-left", hiddenLeft);
    chip.classList.toggle("fade-right", hiddenRight);
  };
  if (!chip.dataset.ready) {
    chip.dataset.ready = "1";
    chip.addEventListener("scroll", refresh, { passive: true });
    window.addEventListener("resize", refresh);
    // Drag-to-scroll handled in JS for touch, pen and mouse alike, so it does not depend on how a given mobile
    // browser treats native overflow scrolling inside a flex header (touch-action is "none" on the chip).
    chip.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      if (chip.scrollWidth - chip.clientWidth <= 1) return;
      const startX = event.clientX;
      const startLeft = chip.scrollLeft;
      let lastX = startX;
      let lastT = event.timeStamp;
      let velocity = 0;
      let moved = false;
      chip.classList.add("dragging");
      try {
        chip.setPointerCapture(event.pointerId);
      } catch {
        /* capture is optional */
      }
      const move = (moveEvent) => {
        const dx = moveEvent.clientX - startX;
        if (!moved && Math.abs(dx) < 3) return;
        moved = true;
        chip.scrollLeft = startLeft - dx;
        const dt = Math.max(1, moveEvent.timeStamp - lastT);
        velocity = (moveEvent.clientX - lastX) / dt;
        lastX = moveEvent.clientX;
        lastT = moveEvent.timeStamp;
        moveEvent.preventDefault();
      };
      const glide = () => {
        if (Math.abs(velocity) < 0.02) return;
        chip.scrollLeft -= velocity * 16;
        velocity *= 0.92;
        requestAnimationFrame(glide);
      };
      const stop = () => {
        chip.classList.remove("dragging");
        chip.removeEventListener("pointermove", move);
        chip.removeEventListener("pointerup", stop);
        chip.removeEventListener("pointercancel", stop);
        if (moved) glide();
      };
      chip.addEventListener("pointermove", move);
      chip.addEventListener("pointerup", stop);
      chip.addEventListener("pointercancel", stop);
    });
    chip.addEventListener(
      "wheel",
      (event) => {
        if (chip.scrollWidth - chip.clientWidth <= 1) return;
        const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
        chip.scrollLeft += delta;
        event.preventDefault();
      },
      { passive: false },
    );
  }
  chip.scrollLeft = 0;
  refresh();
  requestAnimationFrame(refresh);
}

async function prepareWorkspace() {
  const [regions, categories] = await Promise.all([
    api("/api/admin/regions"),
    api("/api/admin/categories"),
  ]);
  state.regions = regions.regions;
  state.categories = categories.categories;
  const regionNameValue = regionName(state.user.region_id);
  const placeLabel = ["super_admin", "country_admin"].includes(state.user.role)
    ? roleLabel(state.user.role)
    : `${roleLabel(state.user.role)} ${regionNameValue}`;
  const userChip = document.getElementById("user-chip");
  userChip.textContent = `${state.user.full_name} · ${placeLabel}`;
  setupUserChip(userChip);
  setScopeBanner();
  beginQuickCompose();
  document.querySelectorAll("[data-super-only]").forEach((element) => {
    element.hidden = state.user.role !== "super_admin";
  });
  document.getElementById("new-user-button").hidden =
    state.user.role === "city_admin";
  document.querySelectorAll("[data-show-roles]").forEach((element) => {
    element.hidden = !element.dataset.showRoles
      .split(",")
      .includes(state.user.role);
  });
  document.querySelectorAll("[data-hide-city]").forEach((element) => {
    element.hidden = state.user.role === "city_admin";
  });
  if (matchMedia("(max-width: 767px)").matches) goToView("mobile-compose");
  else goToView("dashboard");
}

async function loadDashboard() {
  try {
    const data = await api("/api/admin/stats");
    const entries = [
      ["همهٔ خبرها", data.counts.total],
      ["پیش‌نویس", data.counts.draft],
      ["زمان‌بندی‌شده", data.counts.scheduled],
      ["منتشرشده", data.counts.published],
    ];
    document.getElementById("dashboard-counts").innerHTML = entries
      .map(
        ([label, value]) =>
          `<article class="stat-card"><span>${label}</span><strong>${faDigits.format(value)}</strong></article>`,
      )
      .join("");
    document.getElementById("dashboard-latest").innerHTML = data.latest.length
      ? data.latest.map((item) => compactNews(item)).join("")
      : '<p class="empty-panel">خبری برای نمایش وجود ندارد.</p>';
  } catch (error) {
    showToast(error.message);
  }
}

function compactNews(item, action = "edit-news") {
  const date = item.published_at || item.updated_at || item.created_at;
  return `<article class="compact-item"><div class="compact-item-main"><strong>${escapeHtml(item.title)}${item.source_url ? ' <span class="auto-badge">خودکار</span>' : ""}</strong><small>${statusLabel(item.status)} · ${formatDate(date)} · ${faDigits.format(item.view_count || 0)} بازدید</small></div><div class="compact-actions"><button class="mini-button" type="button" data-action="${action}" data-id="${Number(item.id)}">مشاهده</button></div></article>`;
}

function renderNewsTable(items) {
  if (!items.length)
    return '<p class="empty-panel">خبری با این فیلتر پیدا نشد.</p>';
  return `<table class="table"><thead><tr><th>عنوان</th><th>مبدأ و مقصد</th><th>دسته‌بندی</th><th>وضعیت</th><th>بازدید</th><th>آخرین تغییر</th><th></th></tr></thead><tbody>${items
    .map(
      (item) => `<tr>
    <td><strong>${escapeHtml(item.title)}</strong>${item.source_url ? ' <span class="auto-badge">خودکار</span>' : ""}<br><small>${escapeHtml(item.summary || "")}</small></td>
    <td>${escapeHtml(item.origin_region_name)}<br><small>${escapeHtml(scopeLabel(item.targets))}</small></td>
    <td>${escapeHtml(item.category_name || "—")}</td>
    <td><span class="status-badge ${escapeHtml(item.status)}">${statusLabel(item.status)}</span>${item.is_urgent ? '<span class="urgent-label"> · فوری</span>' : ""}</td>
    <td>${faDigits.format(item.view_count)}</td><td>${formatDate(item.updated_at)}</td>
    <td><button class="mini-button" type="button" data-action="edit-news" data-id="${Number(item.id)}">${item.source_url ? "مشاهده" : "بازکردن"}</button></td>
  </tr>`,
    )
    .join("")}</tbody></table>`;
}

// ---------- Pagination (numbered pages, shared by every long list) ----------
const PAGE_SIZE = 10;
const USERS_PAGE_SIZE = 15;

function pageWindow(page, pages) {
  const wanted = new Set([1, pages, page - 1, page, page + 1]);
  const list = [...wanted]
    .filter((value) => value >= 1 && value <= pages)
    .sort((a, b) => a - b);
  const result = [];
  for (const value of list) {
    if (result.length && value - result.at(-1) > 1) result.push(null);
    result.push(value);
  }
  return result;
}

// Fills the pager element: previous / numbers / next plus "from-to of total". Buttons carry data-page.
function renderPager(element, { page, pages, total, limit }) {
  if (!element) return;
  if (!total || pages <= 1) {
    element.innerHTML = total
      ? `<p class="pager-info">${faDigits.format(total)} مورد</p>`
      : "";
    return;
  }
  const from = (page - 1) * limit + 1;
  const to = Math.min(total, page * limit);
  const numbers = pageWindow(page, pages)
    .map((value) =>
      value === null
        ? '<span class="pager-gap" aria-hidden="true">…</span>'
        : `<button type="button" class="pager-button pager-number${value === page ? " is-current" : ""}" data-page="${value}" ${value === page ? 'aria-current="page"' : ""} aria-label="صفحهٔ ${faDigits.format(value)}">${faDigits.format(value)}</button>`,
    )
    .join("");
  element.innerHTML = `<nav class="pager" aria-label="صفحه‌بندی">
    <button type="button" class="pager-button pager-step" data-page="${page - 1}" ${page <= 1 ? "disabled" : ""}>› قبلی</button>
    <div class="pager-numbers">${numbers}</div>
    <button type="button" class="pager-button pager-step" data-page="${page + 1}" ${page >= pages ? "disabled" : ""}>بعدی ‹</button>
  </nav><p class="pager-info">${faDigits.format(from)} تا ${faDigits.format(to)} از ${faDigits.format(total)} · صفحهٔ ${faDigits.format(page)} از ${faDigits.format(pages)}</p>`;
}

function scrollToList(element) {
  const behavior = matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
  element?.closest(".admin-view")?.scrollIntoView({ block: "start", behavior });
}

async function loadNewsList(page = state.newsPage) {
  state.newsPage = page;
  const params = new URLSearchParams({
    status: document.getElementById("news-status").value || "all",
    scope: document.getElementById("news-scope").value || "all",
    text: document.getElementById("news-search").value.trim(),
    limit: String(PAGE_SIZE),
    page: String(page),
    source: "manual", // automatic portal news are managed from the news-feed view
  });
  const container = document.getElementById("news-table");
  const pager = document.getElementById("news-pager");
  if (!container.querySelector("table"))
    container.innerHTML = '<p class="empty-panel">در حال دریافت خبرها…</p>';
  try {
    const data = await api(`/api/admin/news?${params}`);
    state.newsPage = data.page;
    container.innerHTML = renderNewsTable(data.items);
    renderPager(pager, data);
  } catch (error) {
    container.innerHTML = `<p class="empty-panel">${escapeHtml(error.message)}</p>`;
    if (pager) pager.innerHTML = "";
  }
}

function faKey(value) {
  return String(value ?? "")
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/[\u200c\s]+/g, "")
    .toLowerCase();
}

function targetModel() {
  const user = state.user;
  if (!user) return null;
  if (user.role === "city_admin")
    return { kind: "city", rootId: Number(user.region_id), options: [] };
  if (user.role === "super_admin" || user.role === "country_admin") {
    const root = state.regions.find((region) => region.type === "country");
    if (!root) return null;
    return {
      kind: "country",
      rootId: Number(root.id),
      rootLabel: "کل کشور",
      someLabel: "استان‌های مشخص",
      noun: "استان",
      options: state.regions.filter((region) => region.type === "province"),
    };
  }
  const own = state.regions.find(
    (region) => Number(region.id) === Number(user.region_id),
  );
  if (!own) return null;
  return {
    kind: "province",
    rootId: Number(own.id),
    rootLabel: `کل استان ${own.name}`,
    someLabel: "مراکز دانشگاهی مشخص",
    noun: "مرکز دانشگاهی",
    options: state.regions.filter(
      (region) =>
        region.type === "city" && Number(region.parent_id) === Number(own.id),
    ),
  };
}

function renderTargetPicker(fieldsetId, selected = []) {
  const fieldset = document.getElementById(fieldsetId);
  const model = targetModel();
  fieldset.dataset.preserved = "[]";
  if (!model || model.kind === "city") {
    fieldset.hidden = true;
    fieldset.innerHTML = "";
    return;
  }
  fieldset.hidden = false;
  const chosen = new Set(selected.map(Number));
  const optionIds = new Set(model.options.map((region) => Number(region.id)));
  const useSome =
    !chosen.has(model.rootId) && [...chosen].some((id) => optionIds.has(id));
  const preserved = [...chosen].filter(
    (id) => id !== model.rootId && !optionIds.has(id),
  );
  fieldset.dataset.preserved = JSON.stringify(preserved);
  const hasOptions = model.options.length > 0;
  const mode = `${fieldsetId}-mode`;
  fieldset.innerHTML = `<legend>مقصد انتشار</legend>
    <div class="seg" role="radiogroup" aria-label="مقصد انتشار">
      <label class="seg-item"><input type="radio" name="${mode}" value="all" ${useSome ? "" : "checked"}><span>${escapeHtml(model.rootLabel)}</span></label>
      ${hasOptions ? `<label class="seg-item"><input type="radio" name="${mode}" value="some" ${useSome ? "checked" : ""}><span>${escapeHtml(model.someLabel)}</span></label>` : ""}
    </div>
    <div class="target-some" ${useSome ? "" : "hidden"}>
      <div class="target-tools">
        ${model.options.length > 10 ? `<label class="target-search"><input type="search" placeholder="جست‌وجوی ${model.noun}" data-target-search aria-label="جست‌وجوی ${model.noun}"></label>` : ""}
        <button type="button" class="text-button" data-target-toggle="all">انتخاب همه</button>
        <button type="button" class="text-button" data-target-toggle="none">پاک کردن</button>
      </div>
      <div class="target-grid">${model.options.map((region) => `<label class="target-chip" data-name="${escapeHtml(faKey(region.name))}"><input type="checkbox" value="${Number(region.id)}" ${chosen.has(Number(region.id)) ? "checked" : ""}><span>${escapeHtml(region.name)}</span></label>`).join("")}</div>
    </div>
    <p class="target-count muted" aria-live="polite"></p>`;
  updateTargetCount(fieldset);
}

function updateTargetCount(fieldset) {
  const model = targetModel();
  const count = fieldset.querySelector(".target-count");
  if (!model || !count) return;
  const some = fieldset.querySelector(
    'input[type=radio][value="some"]',
  )?.checked;
  const picked = fieldset.querySelectorAll(".target-grid input:checked").length;
  count.textContent = some
    ? picked
      ? `${faDigits.format(picked)} ${model.noun} انتخاب شده است.`
      : `حداقل یک ${model.noun} را انتخاب کنید.`
    : `خبر برای ${model.rootLabel} منتشر می‌شود.`;
}

function readTargets(fieldsetId) {
  const model = targetModel();
  if (!model) return [];
  if (model.kind === "city") return [model.rootId];
  const fieldset = document.getElementById(fieldsetId);
  if (!fieldset.querySelector('input[type=radio][value="some"]')?.checked)
    return [model.rootId];
  const picked = [
    ...fieldset.querySelectorAll(".target-grid input:checked"),
  ].map((input) => Number(input.value));
  let preserved = [];
  try {
    preserved = JSON.parse(fieldset.dataset.preserved || "[]");
  } catch {}
  return [...picked, ...preserved];
}

function requireTargets(fieldsetId) {
  const targets = readTargets(fieldsetId);
  if (!targets.length)
    throw new Error(
      `حداقل یک ${targetModel()?.noun || "مقصد"} را برای انتشار انتخاب کنید.`,
    );
  return targets;
}

function handleTargetPickerEvent(event) {
  const fieldset = event.target.closest(".target-picker");
  if (!fieldset) return;
  if (event.type === "change" && event.target.matches("input[type=radio]")) {
    fieldset.querySelector(".target-some").hidden =
      event.target.value !== "some";
  }
  if (event.type === "input" && event.target.matches("[data-target-search]")) {
    const query = faKey(event.target.value);
    fieldset.querySelectorAll(".target-chip").forEach((chip) => {
      chip.hidden = Boolean(query) && !chip.dataset.name.includes(query);
    });
    return;
  }
  if (event.type === "click") {
    const toggle = event.target.closest("[data-target-toggle]");
    if (!toggle) return;
    const checked = toggle.dataset.targetToggle === "all";
    fieldset
      .querySelectorAll(".target-chip:not([hidden]) input")
      .forEach((input) => {
        input.checked = checked;
      });
  }
  updateTargetCount(fieldset);
}

function selectedTargets() {
  return readTargets("editor-target-fieldset");
}

function setEditorMode(status) {
  const form = document.getElementById("news-editor");
  const later = form.querySelector(
    'input[name="schedule_mode"][value="later"]',
  ).checked;
  const published = status === "published";
  document.getElementById("editor-when-group").hidden = published;
  document.getElementById("editor-when").hidden = !later || published;
  const publish = document.getElementById("editor-publish");
  publish.hidden = published;
  publish.textContent = later ? "زمان‌بندی انتشار" : "انتشار اکنون";
  const save = document.getElementById("editor-save");
  save.textContent = published ? "ذخیرهٔ تغییرات" : "ذخیرهٔ پیش‌نویس";
  save.classList.toggle("primary", published);
  save.classList.toggle("outline", !published);
  const badge = document.getElementById("editor-status");
  const known = ["draft", "scheduled", "published"].includes(status)
    ? status
    : "draft";
  badge.className = `status-badge ${known}`;
  badge.textContent = status ? statusLabel(known) : "جدید";
}

function categoryOptionsHtml(value = "") {
  const usable = state.categories.filter(
    (category) =>
      category.is_active !== false || Number(category.id) === Number(value),
  );
  const placeholder = usable.length
    ? "انتخاب دسته‌بندی…"
    : "ابتدا یک دسته‌بندی بسازید";
  return (
    `<option value="" disabled>${placeholder}</option>` +
    usable
      .map(
        (category) =>
          `<option value="${Number(category.id)}">${escapeHtml(category.name)}${category.is_active === false ? " (غیرفعال)" : ""}</option>`,
      )
      .join("")
  );
}

function setCategoryOptions(value = "") {
  const select = document.querySelector('#news-editor [name="category_id"]');
  select.innerHTML = categoryOptionsHtml(value);
  select.value = value == null ? "" : String(value);
}

// Where the editor's back button / delete leads: the feed for portal items, otherwise the news list
// (on a phone that list is "خبرهای من").
function editorReturnView() {
  if (state.editorFromFeed) return "mobile-feed";
  return matchMedia("(max-width: 767px)").matches ? "mobile-recent" : "news";
}

// ---------- Unsaved-changes guard ----------
function editorSnapshot() {
  const form = document.getElementById("news-editor");
  return JSON.stringify({
    id: form.elements.news_id.value,
    title: form.elements.title.value,
    summary: form.elements.summary.value,
    body: document.getElementById("editor-body").innerHTML,
    category: form.elements.category_id.value,
    type: form.elements.news_type.value,
    pinned: form.elements.is_pinned.checked,
    urgent: form.elements.is_urgent.checked,
    mode: form.elements.schedule_mode.value,
    dates: state.newsDates,
    targets: [...readTargets("editor-target-fieldset")].sort(),
    uploads: allUploadEntries().map(
      (entry) => `${entry.file.name}:${entry.file.size}`,
    ),
  });
}

function markEditorClean() {
  state.editorBaseline = editorSnapshot();
}

function editorIsDirty() {
  return (
    state.activeView === "editor" &&
    state.currentNews?.can_edit !== false &&
    editorSnapshot() !== state.editorBaseline
  );
}

async function confirmLeaveEditor() {
  if (!editorIsDirty()) return true;
  return confirmDialog({
    title: "از ویرایشگر خارج می‌شوید؟",
    text: "این خبر هنوز ذخیره یا منتشر نشده و اگر خارج شوید، تغییرات شما پاک می‌شود.",
    tone: "warning",
    confirmText: "بله، خارج شو",
    cancelText: "ماندن در ویرایشگر",
  });
}

async function goToViewGuarded(view) {
  if (
    state.activeView === "editor" &&
    view !== "editor" &&
    !(await confirmLeaveEditor())
  )
    return;
  goToView(view);
}

function resetEditor() {
  state.editorFromFeed = false;
  const form = document.getElementById("news-editor");
  form.reset();
  form.elements.news_id.value = "";
  document.getElementById("editor-body").innerHTML = "";
  document.getElementById("editor-heading").textContent = "خبر تازه";
  document.getElementById("editor-delete").hidden = true;
  document.getElementById("editor-unpublish").hidden = true;
  document.getElementById("editor-attachments").hidden = true;
  document.getElementById("editor-error").textContent = "";
  state.newsDates = { published_at: null, expires_at: null };
  updateDateLabel("published_at");
  updateDateLabel("expires_at");
  setCategoryOptions();
  renderTargetPicker("editor-target-fieldset");
  state.currentNews = null;
  form.querySelectorAll("input,textarea,select,button").forEach((element) => {
    element.disabled = false;
  });
  form.querySelector('input[name="schedule_mode"][value="now"]').checked = true;
  form.querySelector('input[name="news_type"][value="news"]').checked = true;
  document.getElementById("editor-media").open = false;
  document.getElementById("editor-more").open = false;
  resetUploads();
  setEditorMode(null);
  goToView("editor");
  markEditorClean();
}

async function openEditor(id) {
  resetEditor();
  if (!id) return;
  try {
    const { item } = await api(`/api/admin/news/${id}`);
    state.currentNews = item;
    const form = document.getElementById("news-editor");
    form.elements.news_id.value = String(item.id);
    form.elements.title.value = item.title;
    form.elements.summary.value = item.summary || "";
    form.elements.is_pinned.checked = Boolean(item.is_pinned);
    form.elements.is_urgent.checked = Boolean(item.is_urgent);
    document.getElementById("editor-body").innerHTML = item.body_html || "";
    document.getElementById("editor-heading").textContent = item.source_url
      ? "خبر خودکار پورتال (فقط خواندنی)"
      : item.can_edit
        ? "ویرایش خبر"
        : "مشاهدهٔ خبر (فقط خواندنی)";
    setCategoryOptions(item.category_id);
    form.querySelector(
      `input[name="news_type"][value="${item.news_type === "announcement" ? "announcement" : "news"}"]`,
    ).checked = true;
    renderTargetPicker(
      "editor-target-fieldset",
      (item.targets || []).map((target) => Number(target.id)),
    );
    state.newsDates = {
      published_at: item.published_at || null,
      expires_at: item.expires_at || null,
    };
    updateDateLabel("published_at");
    updateDateLabel("expires_at");
    form.querySelector(
      `input[name="schedule_mode"][value="${item.status === "scheduled" ? "later" : "now"}"]`,
    ).checked = true;
    document.getElementById("editor-more").open = Boolean(
      item.is_pinned || item.is_urgent || item.expires_at,
    );
    document.getElementById("editor-media").open = Boolean(
      (item.attachments || []).length,
    );
    state.editorFromFeed = Boolean(item.source_url);
    const canDeleteImported =
      Boolean(item.source_url) && FEED_ROLES.includes(state.user.role);
    document.getElementById("editor-delete").hidden = !(
      item.can_edit || canDeleteImported
    );
    document.getElementById("editor-unpublish").hidden =
      !item.can_edit || item.status === "draft";
    renderAttachments(item.attachments || [], item.can_edit);
    form.querySelectorAll("input,textarea,select,button").forEach((element) => {
      if (!element.matches('[data-action="back-news"]'))
        element.disabled = !item.can_edit;
    });
    document.getElementById("editor-publish").disabled = !item.can_edit;
    if (canDeleteImported)
      document.getElementById("editor-delete").disabled = false;
    setEditorMode(item.status);
    goToView("editor");
    markEditorClean();
  } catch (error) {
    showToast(error.message);
  }
}

function renderAttachments(attachments, editable) {
  const panel = document.getElementById("editor-attachments");
  panel.hidden = !attachments.length;
  if (!attachments.length) {
    panel.innerHTML = "";
    return;
  }
  const groups = [
    ["تصویر جلد", attachments.filter((item) => item.kind === "cover")],
    ["تصاویر دیگر", attachments.filter((item) => item.kind === "image")],
    ["فایل‌های پیوست", attachments.filter((item) => item.kind === "file")],
  ].filter(([, items]) => items.length);
  const row = (item) => {
    const isFile = item.kind === "file";
    const href = isFile ? item.url : item.src;
    const thumb = isFile
      ? '<svg class="icon" aria-hidden="true"><use href="#admin-icon-file"/></svg>'
      : `<img src="${escapeHtml(String(item.src).replace("-800.webp", "-400.webp"))}" alt="" loading="lazy">`;
    return (
      `<li class="attachment-row"><a class="attachment-thumb" href="${escapeHtml(href)}" target="_blank" rel="noopener" aria-label="باز کردن">${thumb}</a>` +
      `<div class="attachment-info"><span class="attachment-name" title="${escapeHtml(item.original_name)}">${escapeHtml(item.original_name)}</span><small>${formatBytes(item.size_bytes)}</small></div>` +
      (editable
        ? `<button class="mini-button danger" type="button" data-remove-attachment="${Number(item.id)}">حذف</button>`
        : "") +
      "</li>"
    );
  };
  panel.innerHTML =
    "<h2>پیوست‌های ثبت‌شده</h2>" +
    groups
      .map(
        ([title, items]) =>
          `<section class="attachment-group"><h3>${title} <span>${faDigits.format(items.length)}</span></h3><ul>${items.map(row).join("")}</ul></section>`,
      )
      .join("");
}

function editorBody() {
  return document.getElementById("editor-body").innerHTML;
}

function editorPayload() {
  const form = document.getElementById("news-editor");
  if (!form.elements.category_id.value)
    throw new Error("دسته‌بندی خبر را انتخاب کنید.");
  return {
    title: form.elements.title.value.trim(),
    summary: form.elements.summary.value.trim(),
    body_html: editorBody(),
    category_id: form.elements.category_id.value
      ? Number(form.elements.category_id.value)
      : null,
    news_type:
      form.elements.news_type.value === "announcement"
        ? "announcement"
        : "news",
    targets: requireTargets("editor-target-fieldset"),
    expires_at: state.newsDates.expires_at,
  };
}

// ---------- Attachments: drag & drop zones with upload progress ----------
const UPLOAD_RULES = {
  imageBytes: 12 * 1024 * 1024,
  fileBytes: 15 * 1024 * 1024,
  maxImages: 10, // cover + other images, counted together with the ones already saved on the news
  maxFiles: 8,
  fileExtensions: new Set([
    "pdf",
    "doc",
    "docx",
    "xls",
    "xlsx",
    "ppt",
    "pptx",
    "zip",
    "txt",
    "csv",
  ]),
};

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024)
    return `${new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 1 }).format(bytes / 1024 / 1024)} مگابایت`;
  return `${new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 0 }).format(Math.max(1, bytes / 1024))} کیلوبایت`;
}

function uploadPercent(entry) {
  return faDigits.format(Math.round(entry.percent)) + "٪";
}

function uploadStatusText(entry) {
  if (entry.status === "uploading")
    return entry.processing
      ? "در حال پردازش روی سرور…"
      : `در حال ارسال… ${uploadPercent(entry)}`;
  if (entry.status === "done") return "ارسال شد";
  if (entry.status === "failed") return entry.error || "ارسال ناموفق بود";
  return `آمادهٔ ارسال · ${formatBytes(entry.file.size)}`;
}

function resetUploads() {
  state.uploads = { cover: [], images: [], files: [] };
  for (const zone of Object.keys(state.uploads)) renderUploadQueue(zone);
  document.getElementById("upload-total").hidden = true;
}

function renderUploadQueue(zone) {
  const list = document.querySelector(`[data-queue="${zone}"]`);
  const locked = document.querySelector(
    `[data-zone="${zone}"] .dropzone-input`,
  )?.disabled;
  list.innerHTML = state.uploads[zone]
    .map(
      (entry) =>
        `<li class="upload-item is-${entry.status}" data-upload-id="${entry.id}">` +
        `<div class="upload-thumb">${entry.thumb ? `<img src="${entry.thumb}" alt="">` : '<svg class="icon" aria-hidden="true"><use href="#admin-icon-file"/></svg>'}</div>` +
        `<div class="upload-meta"><span class="upload-name" title="${escapeHtml(entry.file.name)}">${escapeHtml(entry.file.name)}</span>` +
        `<progress max="100" value="${Math.round(entry.percent)}"${entry.status === "uploading" || entry.status === "done" ? "" : " hidden"}></progress>` +
        `<div class="upload-status"><span>${escapeHtml(uploadStatusText(entry))}</span></div></div>` +
        `<button type="button" class="upload-remove" data-upload-remove="${entry.id}" aria-label="حذف از فهرست"${locked || state.busy ? " disabled" : ""}><svg class="icon" aria-hidden="true"><use href="#admin-icon-close"/></svg></button></li>`,
    )
    .join("");
}

// Progress events fire many times per second, so only the affected row is touched.
function updateUploadItem(entry) {
  const row = document.querySelector(`[data-upload-id="${entry.id}"]`);
  if (!row) return;
  row.className = `upload-item is-${entry.status}`;
  const bar = row.querySelector("progress");
  bar.hidden = !(entry.status === "uploading" || entry.status === "done");
  bar.value = Math.round(entry.percent);
  row.querySelector(".upload-status span").textContent =
    uploadStatusText(entry);
}

function allUploadEntries() {
  return [
    ...state.uploads.cover,
    ...state.uploads.images,
    ...state.uploads.files,
  ];
}

function updateUploadTotal() {
  const entries = allUploadEntries();
  const total = entries.reduce((sum, entry) => sum + entry.file.size, 0) || 1;
  const loaded = entries.reduce(
    (sum, entry) =>
      sum +
      entry.file.size * (entry.status === "done" ? 1 : entry.percent / 100),
    0,
  );
  const percent = Math.min(100, Math.round((loaded / total) * 100));
  const finished = entries.filter(
    (entry) => entry.status === "done" || entry.status === "failed",
  ).length;
  document.getElementById("upload-total-bar").value = percent;
  document.getElementById("upload-total-percent").textContent =
    `${faDigits.format(percent)}٪`;
  document.getElementById("upload-total-label").textContent =
    `در حال ارسال پیوست‌ها… ${faDigits.format(Math.min(finished + 1, entries.length))} از ${faDigits.format(entries.length)}`;
}

async function makeThumbnail(file) {
  try {
    const bitmap = await createImageBitmap(file, {
      resizeWidth: 96,
      resizeQuality: "low",
    });
    const canvas = document.createElement("canvas");
    canvas.width = 88;
    canvas.height = 88;
    const side = Math.min(bitmap.width, bitmap.height);
    canvas
      .getContext("2d")
      .drawImage(
        bitmap,
        (bitmap.width - side) / 2,
        (bitmap.height - side) / 2,
        side,
        side,
        0,
        0,
        88,
        88,
      );
    bitmap.close?.();
    return canvas.toDataURL("image/jpeg", 0.7);
  } catch {
    return null;
  }
}

function savedAttachmentCounts() {
  const saved = state.currentNews?.attachments || [];
  return {
    images: saved.filter(
      (item) => item.kind === "image" || item.kind === "cover",
    ).length,
    files: saved.filter((item) => item.kind === "file").length,
  };
}

function addUploadFiles(zone, fileList) {
  const picked = [...fileList];
  if (!picked.length) return;
  const problems = [];
  const accepted = [];
  const sameFile = (entry, file) =>
    entry.file.name === file.name &&
    entry.file.size === file.size &&
    entry.file.lastModified === file.lastModified;
  const saved = savedAttachmentCounts();
  for (const file of picked) {
    if (zone === "files") {
      const extension = file.name.includes(".")
        ? file.name.split(".").pop().toLowerCase()
        : "";
      if (!UPLOAD_RULES.fileExtensions.has(extension)) {
        problems.push(`«${file.name}» از نوع‌های مجاز نیست.`);
        continue;
      }
      if (file.size > UPLOAD_RULES.fileBytes) {
        problems.push(`«${file.name}» بزرگ‌تر از ۱۵ مگابایت است.`);
        continue;
      }
    } else {
      if (!file.type.startsWith("image/")) {
        problems.push(`«${file.name}» تصویر نیست.`);
        continue;
      }
      if (file.size > UPLOAD_RULES.imageBytes) {
        problems.push(`«${file.name}» بزرگ‌تر از ۱۲ مگابایت است.`);
        continue;
      }
    }
    if (
      state.uploads[zone].some((entry) => sameFile(entry, file)) ||
      accepted.some((other) => other === file)
    )
      continue;
    accepted.push(file);
  }
  let chosen = accepted;
  if (zone === "cover") {
    if (chosen.length > 1)
      problems.push(
        "فقط یک تصویر جلد می‌توان انتخاب کرد؛ نخستین تصویر برداشته شد.",
      );
    chosen = chosen.slice(0, 1);
    state.uploads.cover = [];
  } else {
    const used =
      zone === "files"
        ? saved.files + state.uploads.files.length
        : saved.images +
          state.uploads.cover.length +
          state.uploads.images.length;
    const limit =
      zone === "files" ? UPLOAD_RULES.maxFiles : UPLOAD_RULES.maxImages;
    const room = Math.max(0, limit - used);
    if (chosen.length > room) {
      problems.push(
        zone === "files"
          ? "برای هر خبر حداکثر ۸ فایل پیوست می‌توان گذاشت."
          : "برای هر خبر حداکثر ۱۰ تصویر (با احتساب جلد) می‌توان گذاشت.",
      );
      chosen = chosen.slice(0, room);
    }
  }
  for (const file of chosen) {
    const entry = {
      id: String(++state.uploadSeq),
      file,
      status: "queued",
      percent: 0,
      processing: false,
      error: "",
      thumb: null,
    };
    state.uploads[zone].push(entry);
    if (zone !== "files") {
      makeThumbnail(file).then((thumb) => {
        if (!thumb) return;
        entry.thumb = thumb;
        const image = document.querySelector(
          `[data-upload-id="${entry.id}"] .upload-thumb`,
        );
        if (image) image.innerHTML = `<img src="${thumb}" alt="">`;
      });
    }
  }
  renderUploadQueue(zone);
  if (problems.length) showToast(problems[0]);
  if (chosen.length) document.getElementById("editor-media").open = true;
}

function uploadWithProgress(path, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", path);
    request.withCredentials = true;
    request.setRequestHeader("accept", "application/json");
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total)
        onProgress?.(event.loaded / event.total);
    });
    request.addEventListener("load", () => {
      let payload = {};
      try {
        payload = JSON.parse(request.responseText);
      } catch {}
      if (request.status >= 200 && request.status < 300) resolve(payload);
      else reject(new Error(payload.error || "ارسال فایل ناموفق بود."));
    });
    request.addEventListener("error", () =>
      reject(
        new Error(
          "فایل به سرور نرسید؛ اتصال اینترنت را بررسی کنید و دوباره تلاش کنید.",
        ),
      ),
    );
    request.addEventListener("timeout", () =>
      reject(new Error("مهلت ارسال تمام شد؛ دوباره تلاش کنید.")),
    );
    request.addEventListener("abort", () => reject(new Error("ارسال لغو شد.")));
    request.send(formData);
  });
}

// Files are sent one by one, so every file gets its own progress bar and one bad file does not block the others.
async function uploadEditorFiles(newsId) {
  const jobs = [
    ...state.uploads.cover.map((entry) => ({ entry, field: "cover" })),
    ...state.uploads.images.map((entry) => ({ entry, field: "image" })),
    ...state.uploads.files.map((entry) => ({ entry, field: "file" })),
  ];
  if (!jobs.length) return;
  document.getElementById("editor-media").open = true;
  document.getElementById("upload-total").hidden = false;
  document
    .querySelectorAll(
      "#editor-media .dropzone-input, #editor-media .upload-remove",
    )
    .forEach((element) => {
      element.disabled = true;
    });
  updateUploadTotal();
  let failed = 0;
  for (const { entry, field } of jobs) {
    entry.status = "uploading";
    entry.percent = 0;
    entry.processing = false;
    entry.error = "";
    updateUploadItem(entry);
    updateUploadTotal();
    const formData = new FormData();
    formData.append(field, entry.file, entry.file.name);
    try {
      await uploadWithProgress(
        `/api/admin/news/${newsId}/attachments`,
        formData,
        (ratio) => {
          entry.percent = Math.min(99, ratio * 100);
          entry.processing = ratio >= 1;
          updateUploadItem(entry);
          updateUploadTotal();
        },
      );
      entry.status = "done";
      entry.percent = 100;
      entry.processing = false;
    } catch (error) {
      entry.status = "failed";
      entry.error = error.message;
      failed += 1;
    }
    updateUploadItem(entry);
    updateUploadTotal();
  }
  for (const zone of Object.keys(state.uploads)) {
    state.uploads[zone] = state.uploads[zone].filter(
      (entry) => entry.status !== "done",
    );
    renderUploadQueue(zone);
  }
  document.getElementById("upload-total").hidden = !failed;
  if (failed) {
    throw new Error(
      failed === 1
        ? "خبر ذخیره شد، اما یک پیوست ارسال نشد. علت را در فهرست پیوست‌ها ببینید و دوباره ذخیره کنید."
        : `خبر ذخیره شد، اما ${faDigits.format(failed)} پیوست ارسال نشد. علت را در فهرست پیوست‌ها ببینید و دوباره ذخیره کنید.`,
    );
  }
}

function bindUploadZones() {
  const container = document.getElementById("editor-media");
  const hasFiles = (event) =>
    [...(event.dataTransfer?.types || [])].includes("Files");
  const zoneOf = (event) => event.target.closest?.("[data-zone]");
  container.addEventListener("dragenter", (event) => {
    if (hasFiles(event) && zoneOf(event)) {
      event.preventDefault();
      zoneOf(event).querySelector(".dropzone").classList.add("is-dragover");
    }
  });
  container.addEventListener("dragover", (event) => {
    if (!hasFiles(event) || !zoneOf(event)) return;
    event.preventDefault();
    const locked = zoneOf(event).querySelector(".dropzone-input").disabled;
    event.dataTransfer.dropEffect = locked ? "none" : "copy";
    zoneOf(event).querySelector(".dropzone").classList.add("is-dragover");
  });
  container.addEventListener("dragleave", (event) => {
    const zone = zoneOf(event);
    if (zone && !zone.contains(event.relatedTarget))
      zone.querySelector(".dropzone").classList.remove("is-dragover");
  });
  container.addEventListener("drop", (event) => {
    const zone = zoneOf(event);
    if (!zone || !hasFiles(event)) return;
    event.preventDefault();
    zone.querySelector(".dropzone").classList.remove("is-dragover");
    if (zone.querySelector(".dropzone-input").disabled) return;
    addUploadFiles(zone.dataset.zone, event.dataTransfer.files);
  });
  container.addEventListener("change", (event) => {
    const input = event.target.closest(".dropzone-input");
    if (!input) return;
    addUploadFiles(input.closest("[data-zone]").dataset.zone, input.files);
    input.value = ""; // so the same file can be picked again after removing it
  });
  container.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-upload-remove]");
    if (!remove) return;
    for (const zone of Object.keys(state.uploads)) {
      if (
        state.uploads[zone].some(
          (entry) => entry.id === remove.dataset.uploadRemove,
        )
      ) {
        state.uploads[zone] = state.uploads[zone].filter(
          (entry) => entry.id !== remove.dataset.uploadRemove,
        );
        renderUploadQueue(zone);
      }
    }
  });
  // A file dropped beside a zone must not make the browser open it and throw the unsaved news away.
  for (const type of ["dragover", "drop"]) {
    window.addEventListener(type, (event) => {
      if (hasFiles(event) && !zoneOf(event)) event.preventDefault();
    });
  }
}

async function saveEditor() {
  const form = document.getElementById("news-editor");
  const id = Number(form.elements.news_id.value) || 0;
  const payload = editorPayload();
  let result;
  if (id) {
    result = await api(`/api/admin/news/${id}`, {
      method: "PUT",
      body: payload,
    });
  } else {
    result = await api("/api/admin/news", { method: "POST", body: payload });
    form.elements.news_id.value = String(result.id);
    state.currentNews = {
      id: Number(result.id),
      status: "draft",
      can_edit: true,
    };
    if (payload.expires_at)
      await api(`/api/admin/news/${result.id}`, {
        method: "PUT",
        body: payload,
      });
  }
  const savedId = id || Number(result.id);
  await uploadEditorFiles(savedId);
  const flags = [
    ["is_pinned", "pin"],
    ["is_urgent", "urgent"],
  ];
  for (const [field, endpoint] of flags) {
    const enabled = form.elements[field].checked;
    if (Boolean(state.currentNews?.[field]) !== enabled) {
      await api(`/api/admin/news/${savedId}/${endpoint}`, {
        method: "POST",
        body: { enabled },
      });
      if (state.currentNews) state.currentNews[field] = enabled;
    }
  }
  return savedId;
}

function setEditorBusy(busy) {
  state.busy = busy;
  const editable = state.currentNews?.can_edit !== false;
  for (const id of ["editor-publish", "editor-save"])
    document.getElementById(id).disabled = busy || !editable;
  document
    .querySelectorAll(
      "#editor-media .dropzone-input, #editor-media .upload-remove",
    )
    .forEach((element) => {
      element.disabled = busy || !editable;
    });
}

async function handleEditorSubmit(event) {
  event.preventDefault();
  if (state.busy) return;
  const error = document.getElementById("editor-error");
  error.textContent = "";
  setEditorBusy(true);
  try {
    const id = await saveEditor();
    showToast(
      state.currentNews?.status === "published"
        ? "تغییرات ذخیره شد."
        : "پیش‌نویس ذخیره شد.",
    );
    await openEditor(id);
  } catch (failure) {
    error.textContent = failure.message;
  } finally {
    setEditorBusy(false);
  }
}

async function publishEditor() {
  if (state.busy) return;
  const error = document.getElementById("editor-error");
  error.textContent = "";
  setEditorBusy(true);
  const scheduled =
    document.querySelector('#news-editor input[name="schedule_mode"]:checked')
      ?.value === "later";
  try {
    if (scheduled && !state.newsDates.published_at)
      throw new Error(
        "برای زمان‌بندی، ابتدا تاریخ و ساعت انتشار را انتخاب کنید.",
      );
    const id = await saveEditor();
    const publishedAt = scheduled
      ? state.newsDates.published_at
      : new Date().toISOString();
    await api(`/api/admin/news/${id}/publish`, {
      method: "POST",
      body: {
        published_at: publishedAt,
        expires_at: state.newsDates.expires_at,
      },
    });
    showToast(scheduled ? "انتشار خبر زمان‌بندی شد." : "خبر منتشر شد.");
    markEditorClean();
    goToView(editorReturnView());
  } catch (failure) {
    error.textContent = failure.message;
  } finally {
    setEditorBusy(false);
  }
}

// ---------- Quick news (messenger-style): title + text + optional cover; everything else is automatic ----------
// Type = news, published immediately, category "اخبار" (the server creates it when missing), published to the user's own scope.
const QUICK_SUMMARY_LENGTH = 300;

function quickExcerpt(text) {
  const plain = text.replace(/\s+/g, " ").trim();
  if (plain.length <= QUICK_SUMMARY_LENGTH) return plain;
  const cut = plain.slice(0, QUICK_SUMMARY_LENGTH);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), QUICK_SUMMARY_LENGTH - 40)).trim()}…`;
}

function quickBodyHtml(text) {
  return text
    .split(/\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join("");
}

// Phone photos are several megabytes and a gallery file can disappear or lose its permission once the picker closes.
// The picture is therefore read into memory right away, scaled down to at most 1600 px (JPEG), and the preview and the
// upload both use that in-memory copy, never the original file handle. If the browser cannot decode it (e.g. HEIC on
// Android) the unchanged bytes are used. An unreadable file fails here with a clear message instead of a broken thumbnail.
const QUICK_COVER_MAX_SIDE = 1600;

async function prepareQuickCover(original) {
  const buffer = await original.arrayBuffer();
  const file = new File([buffer], original.name || "cover", {
    type: original.type || "image/jpeg",
  });
  if (file.size < 400 * 1024 && /^image\/(jpeg|png|webp)$/.test(file.type))
    return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(
      1,
      QUICK_COVER_MAX_SIDE / Math.max(bitmap.width, bitmap.height),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.85),
    );
    if (!blob || (scale === 1 && blob.size >= file.size)) return file;
    return new File(
      [blob],
      `${file.name.replace(/\.[^.]+$/, "") || "cover"}.jpg`,
      { type: "image/jpeg" },
    );
  } catch {
    return file;
  }
}

// The preview is a data: URL (read with FileReader), never blob:. A blob: image is refused by a page that was loaded
// under an older Content-Security-Policy (an installed app kept open in the background keeps the policy it started
// with until it is reloaded), which left the thumbnail broken until the page was refreshed.
let quickCoverToken = 0;

async function setQuickCover(original) {
  const form = document.getElementById("quick-form");
  const chip = document.getElementById("quick-attachment");
  const thumb = chip.querySelector("img");
  const token = ++quickCoverToken;
  state.quickCoverUrl = "";
  state.quickCoverFile = null;
  state.quickCoverPreparing = false;
  thumb.removeAttribute("src");
  let file = original;
  if (file && !file.type.startsWith("image/")) {
    document.getElementById("quick-error").textContent =
      "فقط فایل عکس پذیرفته می‌شود.";
    file = null;
    form.elements.cover.value = "";
  }
  chip.hidden = !file;
  renderQuickPreview();
  if (!file) return;
  chip.querySelector(".attach-name").textContent = file.name;
  chip.querySelector(".attach-size").textContent = "در حال آماده‌سازی…";
  state.quickCoverPreparing = true;
  let prepared;
  try {
    prepared = await prepareQuickCover(file);
  } catch {
    if (token !== quickCoverToken) return;
    state.quickCoverPreparing = false;
    form.elements.cover.value = "";
    chip.hidden = true;
    document.getElementById("quick-error").textContent =
      "این عکس از گوشی خوانده نمی‌شود (شاید هنوز دانلود نشده یا فقط در حافظهٔ ابری است). آن را دوباره از گالری یا با دوربین انتخاب کنید.";
    return;
  }
  if (token !== quickCoverToken) return;
  state.quickCoverPreparing = false;
  state.quickCoverFile = prepared;
  chip.querySelector(".attach-size").textContent =
    `${faDigits.format(Math.max(1, Math.round(prepared.size / 1024)))} کیلوبایت`;
  const reader = new FileReader();
  reader.onload = () => {
    if (token !== quickCoverToken) return;
    state.quickCoverUrl = String(reader.result);
    thumb.src = state.quickCoverUrl;
    renderQuickPreview();
  };
  reader.onerror = () => {
    if (token === quickCoverToken)
      chip.querySelector(".attach-size").textContent = "پیش‌نمایش ممکن نیست";
  };
  reader.readAsDataURL(prepared);
}

function renderQuickPreview() {
  const form = document.getElementById("quick-form");
  const bubble = document.getElementById("quick-bubble");
  const title = form.elements.title.value.trim();
  const text = form.elements.text.value.trim();
  const cover = bubble.querySelector(".bubble-cover");
  bubble.classList.toggle("is-empty", !title && !text && !state.quickCoverUrl);
  bubble.querySelector(".bubble-title").textContent = title || "عنوان خبر";
  bubble.querySelector(".bubble-text").textContent =
    text || "متن خبر شما اینجا مثل یک پیام دیده می‌شود.";
  cover.hidden = !state.quickCoverUrl;
  if (state.quickCoverUrl) cover.querySelector("img").src = state.quickCoverUrl;
  const textarea = form.elements.text;
  // Measured while the screen is hidden, scrollHeight is 0 and the box used to collapse until the first keystroke.
  textarea.style.height = "auto";
  if (textarea.scrollHeight > 0)
    textarea.style.height = `${Math.min(textarea.scrollHeight, 150)}px`;
}

function setQuickBubbleState(mode) {
  const bubble = document.getElementById("quick-bubble");
  bubble.classList.toggle("is-sending", mode === "sending");
  bubble.classList.toggle("is-sent", mode === "sent");
  bubble.querySelector(".bubble-state").textContent =
    mode === "sent"
      ? "منتشر شد"
      : mode === "sending"
        ? "در حال ارسال…"
        : "پیش‌نویس";
  bubble
    .querySelector(".bubble-ticks use")
    .setAttribute(
      "href",
      mode === "sent" ? "#admin-icon-ticks" : "#admin-icon-tick",
    );
}

function beginQuickCompose() {
  const form = document.getElementById("quick-form");
  form.reset();
  state.quickDraft = null;
  setQuickCover(null);
  setQuickBubbleState("draft");
  document.getElementById("quick-error").textContent = "";
  const model = targetModel();
  const scope =
    model?.rootLabel ||
    state.regions.find((region) => Number(region.id) === Number(model?.rootId))
      ?.name ||
    "";
  document.getElementById("quick-scope-label").textContent = scope
    ? `منتشر می‌شود برای: ${scope}`
    : "";
  renderQuickPreview();
}

async function submitQuickCompose(event) {
  event.preventDefault();
  if (state.quickBusy) return;
  const error = document.getElementById("quick-error");
  error.textContent = "";
  const form = event.currentTarget;
  const title = form.elements.title.value.trim();
  const text = form.elements.text.value.trim();
  const send = document.getElementById("quick-send");
  try {
    if (!title) {
      form.elements.title.focus();
      throw new Error("عنوان خبر را بنویسید.");
    }
    if (!text) {
      form.elements.text.focus();
      throw new Error("متن خبر را بنویسید.");
    }
    const rootId = targetModel()?.rootId;
    if (!rootId) throw new Error("محدودهٔ انتشار شما مشخص نیست.");
    if (state.quickCoverPreparing)
      throw new Error("عکس هنوز آماده نشده؛ چند لحظه صبر کنید.");
    if (form.elements.cover.files[0] && !state.quickCoverFile)
      throw new Error("عکس خوانده نشد؛ آن را دوباره انتخاب کنید یا حذفش کنید.");
    state.quickBusy = true;
    send.disabled = true;
    setQuickBubbleState("sending");
    // If an earlier attempt created the draft but the picture failed, retry with that draft instead of making a duplicate.
    const signature = JSON.stringify([title, text, rootId]);
    let created =
      state.quickDraft?.signature === signature ? state.quickDraft : null;
    if (!created) {
      state.quickDraft = null;
      const made = await api("/api/admin/news", {
        method: "POST",
        body: {
          title,
          summary: quickExcerpt(text),
          news_type: "news",
          default_category: true,
          body_html: quickBodyHtml(text),
          targets: [rootId],
        },
      });
      if (made.category_created) {
        try {
          state.categories = (await api("/api/admin/categories")).categories;
        } catch {}
      }
      state.quickDraft = { id: made.id, signature, coverSent: false };
      created = state.quickDraft;
    }
    const cover = created.coverSent ? null : state.quickCoverFile;
    if (cover) {
      const formData = new FormData();
      formData.append("cover", cover);
      const bar = document.getElementById("quick-progress");
      bar.value = 0;
      bar.hidden = false;
      try {
        await uploadWithProgress(
          `/api/admin/news/${created.id}/attachments`,
          formData,
          (ratio) => {
            bar.value = Math.round(ratio * 100);
          },
        );
        created.coverSent = true;
      } finally {
        bar.hidden = true;
      }
    }
    await api(`/api/admin/news/${created.id}/publish`, {
      method: "POST",
      body: {},
    });
    state.quickDraft = null;
    setQuickBubbleState("sent");
    showToast("خبر با موفقیت منتشر شد.");
    loadMobileNews("mine", 1);
    // keep the delivered "message" on screen for a moment, then get ready for the next one
    setTimeout(() => {
      if (document.getElementById("quick-bubble").classList.contains("is-sent"))
        beginQuickCompose();
    }, 1600);
  } catch (failure) {
    setQuickBubbleState("draft");
    error.textContent = failure.message;
  } finally {
    state.quickBusy = false;
    send.disabled = false;
  }
}

async function loadMobileNews(scope, page = state.mobilePages[scope] ?? 1) {
  const mine = scope === "mine";
  state.mobilePages[scope] = page;
  const container = document.getElementById(
    mine ? "mobile-recent" : "mobile-feed",
  );
  const pager = document.getElementById(
    mine ? "mobile-recent-pager" : "mobile-feed-pager",
  );
  if (!container.querySelector(".compact-item"))
    container.innerHTML = '<p class="empty-panel">در حال دریافت…</p>';
  try {
    // "mine" = what this user published; the feed = the automatic portal news only
    const params = new URLSearchParams({
      status: "all",
      scope: mine ? "mine" : "all",
      limit: String(PAGE_SIZE),
      page: String(page),
    });
    if (!mine) params.set("source", "portal");
    const data = await api(`/api/admin/news?${params}`);
    state.mobilePages[scope] = data.page;
    renderPager(pager, data);
    container.innerHTML = data.items.length
      ? data.items.map((item) => compactNews(item, "edit-news")).join("")
      : `<p class="empty-panel">${mine ? "خبری برای نمایش وجود ندارد." : "هنوز خبری از پورتال دریافت نشده است."}</p>`;
  } catch (error) {
    container.innerHTML = `<p class="empty-panel">${escapeHtml(error.message)}</p>`;
  }
}

async function loadUsers(page = state.usersPage) {
  state.usersPage = page;
  const panel = document.getElementById("users-tree");
  const pager = document.getElementById("users-pager");
  if (!panel.querySelector(".tree-province"))
    panel.innerHTML = '<p class="empty-panel">در حال دریافت کاربران…</p>';
  try {
    const data = await api(
      `/api/admin/users?${new URLSearchParams({ page: String(page), limit: String(USERS_PAGE_SIZE) })}`,
    );
    const { users } = data;
    state.usersPage = data.page;
    renderPager(pager, data);
    if (!users.length) {
      panel.innerHTML =
        '<p class="empty-panel">کاربری برای نمایش وجود ندارد.</p>';
      return;
    }
    const grouped = new Map();
    for (const user of users) {
      const parentId =
        user.region_type === "city"
          ? Number(user.parent_region_id)
          : Number(user.region_id);
      if (!grouped.has(parentId)) grouped.set(parentId, []);
      grouped.get(parentId).push(user);
    }
    const subordinateCount = (user) => Number(user.subordinate_count) || 0;
    panel.innerHTML = [...grouped.entries()]
      .map(([parentId, entries]) => {
        const parent = state.regions.find(
          (region) => Number(region.id) === parentId,
        );
        return `<section class="tree-province"><div class="tree-province-heading"><span>${escapeHtml(parent?.name || entries[0].region_name)}</span><span>${faDigits.format(entries.length)} کاربر</span></div>${entries.map((user) => `<div class="tree-city"><div><strong>${escapeHtml(user.full_name)}</strong><small>${roleLabel(user.role)} · ${escapeHtml(user.region_name)} · ${escapeHtml(user.username)}</small></div><div class="compact-actions"><button class="mini-button" data-user-action="reset-password" data-user-id="${Number(user.id)}">بازنشانی گذرواژه</button><button class="mini-button" data-user-action="reset-2fa" data-user-id="${Number(user.id)}">بازنشانی ۲مرحله‌ای</button><button class="mini-button" data-user-action="${user.is_active ? "deactivate" : "activate"}" data-user-id="${Number(user.id)}">${user.is_active ? "غیرفعال‌سازی" : "فعال‌سازی"}</button>${user.role !== "super_admin" && Number(user.id) !== Number(state.user?.id) ? `<button class="mini-button danger" data-user-action="delete" data-user-id="${Number(user.id)}" data-user-name="${escapeHtml(user.full_name)}" data-subordinates="${subordinateCount(user)}">حذف کاربر</button>` : ""}</div></div>`).join("")}</section>`;
      })
      .join("");
  } catch (error) {
    panel.innerHTML = `<p class="empty-panel">${escapeHtml(error.message)}</p>`;
  }
}

// Provinces that already have an active province admin: the main admin may add city users only under these.
async function provincesWithAdmin() {
  const { users } = await api("/api/admin/users");
  const ids = new Set(
    users
      .filter((user) => user.role === "province_admin" && user.is_active)
      .map((user) => Number(user.region_id)),
  );
  return state.regions.filter(
    (region) => region.type === "province" && ids.has(Number(region.id)),
  );
}

function fillUserRegions() {
  const form = document.getElementById("user-form");
  const role = form.elements.role.value;
  const city = role === "city_admin";
  const country = role === "country_admin";
  const isSuper = state.user.role === "super_admin";
  document.getElementById("user-province-label").hidden = !(isSuper && city);
  const provinceId = Number(form.elements.province_id.value);
  const regionType = city ? "city" : country ? "country" : "province";
  const options = state.regions.filter(
    (item) =>
      item.type === regionType &&
      (!isSuper || !city || Number(item.parent_id) === provinceId),
  );
  form.elements.region_id.innerHTML = options
    .map(
      (item) =>
        `<option value="${Number(item.id)}">${escapeHtml(item.name)}</option>`,
    )
    .join("");
  document.getElementById("user-region-label").firstChild.textContent = city
    ? "مرکز دانشگاهی"
    : country
      ? "محدوده"
      : "استان";
}

async function openUserForm() {
  const form = document.getElementById("user-form");
  form.hidden = false;
  form.reset();
  document.getElementById("user-error").textContent = "";
  const role = form.elements.role;
  const isSuper = state.user.role === "super_admin";
  if (state.user.role === "country_admin") {
    role.innerHTML = `<option value="province_admin">${roleLabel("province_admin")}</option>`;
  } else if (isSuper) {
    role.innerHTML = `<option value="country_admin">${roleLabel("country_admin")}</option><option value="province_admin">مدیر استان</option><option value="city_admin">مدیر مرکز دانشگاهی</option>`;
    try {
      const provinces = await provincesWithAdmin();
      form.elements.province_id.innerHTML = provinces
        .map(
          (item) =>
            `<option value="${Number(item.id)}">${escapeHtml(item.name)}</option>`,
        )
        .join("");
      if (!provinces.length)
        role.querySelector('[value="city_admin"]').disabled = true;
    } catch (error) {
      showToast(error.message);
    }
  } else {
    role.innerHTML = `<option value="city_admin">${roleLabel("city_admin")}</option>`;
  }
  fillUserRegions();
  form.scrollIntoView({ block: "center", behavior: "smooth" });
}

async function submitUser(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.getElementById("user-error");
  message.textContent = "";
  try {
    const result = await api("/api/admin/users", {
      method: "POST",
      body: {
        full_name: form.elements.full_name.value,
        username: form.elements.username.value,
        role: form.elements.role.value,
        region_id: Number(form.elements.region_id.value),
      },
    });
    form.hidden = true;
    showMessage(
      "کاربر ساخته شد",
      "این گذرواژهٔ موقت فقط همین‌بار نمایش داده می‌شود. آن را از مسیر امن به کاربر تحویل دهید.",
      result.temporary_password,
    );
    await loadUsers();
  } catch (error) {
    message.textContent = error.message;
  }
}

async function handleUserAction(button) {
  const id = Number(button.dataset.userId);
  const action = button.dataset.userAction;
  if (!id || !action) return;
  const isDelete = action === "delete";
  if (isDelete && Number(button.dataset.subordinates) > 0) {
    showMessage(
      "حذف ممکن نیست",
      `«${button.dataset.userName || "این مدیر"}» هنوز ${faDigits.format(Number(button.dataset.subordinates))} مدیر زیرمجموعه دارد. ابتدا مدیران زیرمجموعه را حذف کنید، سپس این مدیر را حذف کنید.`,
    );
    return;
  }
  const label = button.textContent.trim();
  const confirmed = isDelete
    ? await confirmDialog({
        title: `حذف «${button.dataset.userName || "کاربر"}»؟`,
        text: "این کاربر برای همیشه حذف می‌شود و این کار قابل بازگشت نیست. خبرهایی که او ساخته یا منتشر کرده به مدیر بالادستش منتقل می‌شود.",
        tone: "danger",
        confirmText: "بله، حذف شود",
      })
    : await confirmDialog({
        title: `${label}؟`,
        text: "آیا از انجام این کار مطمئن هستید؟",
        tone: action === "deactivate" ? "warning" : "question",
        confirmText: "بله، انجام شود",
      });
  if (!confirmed) return;
  try {
    const result = await api(
      isDelete ? `/api/admin/users/${id}` : `/api/admin/users/${id}/${action}`,
      { method: isDelete ? "DELETE" : "POST", body: {} },
    );
    if (result.temporary_password)
      showMessage(
        "گذرواژه بازنشانی شد",
        "گذرواژهٔ موقت را فقط یک‌بار به کاربر تحویل دهید.",
        result.temporary_password,
      );
    else if (isDelete)
      showToast(
        result.news_transferred > 0
          ? `کاربر حذف شد و ${faDigits.format(result.news_transferred)} خبر به «${result.transferred_to?.full_name || "مدیر بالادست"}» منتقل شد.`
          : "کاربر حذف شد.",
      );
    else showToast("تغییر انجام شد.");
    await loadUsers();
  } catch (error) {
    showToast(error.message);
  }
}

const VISIBILITY_LABELS = {
  city: [
    ["auto", "خودکار (با وجود مدیر فعال)"],
    ["show", "همیشه نمایش"],
    ["hide", "پنهان"],
  ],
  province: [
    ["auto", "نمایش در سایت"],
    ["hide", "پنهان"],
  ],
};

function unitState(unit, cities = []) {
  if (unit.visibility_override === "hide")
    return { key: "hidden", label: "پنهان", active: false };
  if (unit.type === "city") {
    if (unit.active_admins > 0)
      return { key: "active", label: "فعال", active: true };
    if (unit.visibility_override === "show")
      return { key: "forced", label: "نمایش اجباری", active: true };
    return { key: "inactive", label: "بدون مدیر", active: false };
  }
  return cities.some((city) => unitState(city).active)
    ? { key: "active", label: "فعال", active: true }
    : { key: "inactive", label: "فعال نشده", active: false };
}

function unitBadge(info) {
  const cls =
    info.key === "active"
      ? "published"
      : info.key === "forced"
        ? "draft"
        : info.key === "inactive"
          ? "scheduled"
          : "";
  return `<span class="status-badge ${cls}">${info.label}</span>`;
}

function unitEditForm(unit) {
  const options = VISIBILITY_LABELS[unit.type]
    .map(
      ([value, label]) =>
        `<option value="${value}" ${unit.visibility_override === value ? "selected" : ""}>${label}</option>`,
    )
    .join("");
  return `<form class="unit-edit" data-unit-form="${unit.id}">
    <label>نام ${unit.type === "province" ? "استان" : "مرکز دانشگاهی"}<input name="name" value="${escapeHtml(unit.name)}" maxlength="160" required></label>
    <label>نمایش در سایت<select name="visibility">${options}</select></label>
    <div class="unit-edit-actions"><button class="button primary" type="submit">ذخیره</button><button class="button outline" type="button" data-unit-cancel>انصراف</button></div>
  </form>`;
}

function cityRow(city) {
  if (state.units.editing === city.id)
    return `<div class="unit-row is-editing">${unitEditForm(city)}</div>`;
  const info = unitState(city);
  const admin =
    city.active_admins > 0
      ? `مدیر: ${escapeHtml(city.admin_name || "—")}`
      : "مدیری ثبت نشده";
  return `<div class="unit-row"><div class="unit-main"><span class="unit-name">${escapeHtml(city.name)}</span><small class="muted">${admin}</small></div>${unitBadge(info)}<button class="mini-button" type="button" data-unit-edit="${city.id}">ویرایش</button></div>`;
}

function renderUnits() {
  const container = document.getElementById("regions-tree");
  const summary = document.getElementById("regions-summary");
  const all = state.units.items;
  const provinces = all
    .filter((unit) => unit.type === "province")
    .sort((a, b) => faCollator.compare(a.name, b.name));
  const citiesOf = (provinceId) =>
    all
      .filter((unit) => unit.type === "city" && unit.parent_id === provinceId)
      .sort((a, b) => faCollator.compare(a.name, b.name));
  const allCities = all.filter((unit) => unit.type === "city");
  const activeCities = allCities.filter(
    (city) => unitState(city).active,
  ).length;
  const activeProvinces = provinces.filter(
    (province) => unitState(province, citiesOf(province.id)).active,
  ).length;
  summary.innerHTML = [
    [activeProvinces, `از ${faDigits.format(provinces.length)} استان فعال`],
    [
      activeCities,
      `از ${faDigits.format(allCities.length)} مرکز دانشگاهی فعال`,
    ],
  ]
    .map(
      ([value, label]) =>
        `<div class="units-stat"><strong>${faDigits.format(value)}</strong><span>${label}</span></div>`,
    )
    .join("");

  const query = faKey(document.getElementById("regions-search").value);
  const filter =
    document.querySelector('input[name="regions_filter"]:checked')?.value ||
    "all";
  const wantActive = (active) =>
    filter === "all" || (filter === "active") === active;
  const html = [];
  for (const province of provinces) {
    const cities = citiesOf(province.id);
    const info = unitState(province, cities);
    const provinceMatches = !query || faKey(province.name).includes(query);
    const visibleCities = cities.filter(
      (city) =>
        (provinceMatches || faKey(city.name).includes(query)) &&
        (filter === "all" || wantActive(unitState(city).active)),
    );
    const showProvince =
      (provinceMatches || visibleCities.length) &&
      (filter === "all"
        ? true
        : wantActive(info.active) || visibleCities.length);
    if (!showProvince) continue;
    const shownCities =
      filter === "all" && provinceMatches ? cities : visibleCities;
    const activeCount = cities.filter((city) => unitState(city).active).length;
    const open =
      state.units.open.has(province.id) ||
      Boolean(query) ||
      filter !== "all" ||
      state.units.editing === province.id ||
      cities.some((city) => city.id === state.units.editing);
    const heading =
      state.units.editing === province.id
        ? `<div class="unit-province-edit">${unitEditForm(province)}</div>`
        : `<summary><span class="unit-name">${escapeHtml(province.name)}</span><span class="unit-meta">${faDigits.format(activeCount)} از ${faDigits.format(cities.length)} مرکز دانشگاهی فعال</span>${unitBadge(info)}<button class="mini-button" type="button" data-unit-edit="${province.id}">ویرایش</button></summary>`;
    html.push(
      `<details class="unit-province" data-province="${province.id}" ${open ? "open" : ""}>${state.units.editing === province.id ? `<summary class="is-editing">${escapeHtml(province.name)}</summary>${heading}` : heading}<div class="unit-cities">${shownCities.map(cityRow).join("") || '<p class="empty-panel">مرکز دانشگاهی برای نمایش نیست.</p>'}</div></details>`,
    );
  }
  container.innerHTML =
    html.join("") || '<p class="empty-panel">موردی پیدا نشد.</p>';
}

async function loadRegions() {
  const container = document.getElementById("regions-tree");
  if (!state.units.items.length)
    container.innerHTML = '<p class="empty-panel">در حال دریافت فهرست…</p>';
  try {
    const [overview, targets] = await Promise.all([
      api("/api/admin/regions/overview"),
      api("/api/admin/regions"),
    ]);
    state.units.items = overview.units;
    state.regions = targets.regions;
    renderUnits();
    populateRegionParents();
  } catch (error) {
    container.innerHTML = `<p class="empty-panel">${escapeHtml(error.message)}</p>`;
  }
}

function populateRegionParents() {
  const form = document.getElementById("region-form");
  const isProvince = form.elements.type.value === "province";
  document.getElementById("region-parent-label").hidden = isProvince;
  form.elements.parent_id.innerHTML = state.units.items
    .filter((unit) => unit.type === "province")
    .sort((a, b) => faCollator.compare(a.name, b.name))
    .map(
      (unit) => `<option value="${unit.id}">${escapeHtml(unit.name)}</option>`,
    )
    .join("");
}

async function submitRegion(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.getElementById("region-error");
  message.textContent = "";
  const isProvince = form.elements.type.value === "province";
  try {
    const rootId = state.regions.find(
      (region) => region.type === "country",
    )?.id;
    const parentId = isProvince
      ? Number(rootId)
      : Number(form.elements.parent_id.value);
    await api("/api/admin/regions", {
      method: "POST",
      body: {
        type: form.elements.type.value,
        name: form.elements.name.value,
        parent_id: parentId,
      },
    });
    if (!isProvince) state.units.open.add(parentId);
    form.hidden = true;
    form.reset();
    showToast(isProvince ? "استان افزوده شد." : "مرکز دانشگاهی افزوده شد.");
    await loadRegions();
  } catch (error) {
    message.textContent = error.message;
  }
}

async function saveUnit(form) {
  const id = Number(form.dataset.unitForm);
  const unit = state.units.items.find((item) => item.id === id);
  const body = {};
  if (form.elements.name.value.trim() !== unit.name)
    body.name = form.elements.name.value;
  if (form.elements.visibility.value !== unit.visibility_override)
    body.visibility_override = form.elements.visibility.value;
  state.units.editing = null;
  if (!Object.keys(body).length) {
    renderUnits();
    return;
  }
  try {
    await api(`/api/admin/regions/${id}`, { method: "PATCH", body });
    showToast("تغییرات ذخیره شد.");
  } catch (error) {
    showToast(error.message);
  }
  await loadRegions();
  setScopeBanner();
}

// ---------- Categories (main admin only) ----------
function categoryRow(category, index, total) {
  if (state.categoryAdmin.editing === category.id) {
    return `<div class="category-row is-editing"><form class="category-edit" data-category-form="${category.id}"><label>نام دسته‌بندی<input name="name" maxlength="120" required autocomplete="off" value="${escapeHtml(category.name)}"></label><button class="button primary" type="submit">ذخیره</button><button class="button outline" type="button" data-category-cancel>انصراف</button></form></div>`;
  }
  const count = category.news_count
    ? `${faDigits.format(category.news_count)} خبر`
    : "بدون خبر";
  return (
    `<div class="category-row${category.is_active ? "" : " is-inactive"}" data-category-id="${category.id}">` +
    `<div class="category-main"><span class="category-name">${escapeHtml(category.name)}</span><small>${count}</small></div>` +
    `<span class="status-badge ${category.is_active ? "published" : "draft"}">${category.is_active ? "فعال" : "غیرفعال"}</span>` +
    `<div class="category-actions">` +
    `<button class="mini-button" type="button" data-category-move="up" data-category-id="${category.id}" aria-label="بالا بردن"${index === 0 ? " disabled" : ""}>↑</button>` +
    `<button class="mini-button" type="button" data-category-move="down" data-category-id="${category.id}" aria-label="پایین آوردن"${index === total - 1 ? " disabled" : ""}>↓</button>` +
    `<button class="mini-button" type="button" data-category-edit="${category.id}">ویرایش</button>` +
    `<button class="mini-button" type="button" data-category-toggle="${category.id}">${category.is_active ? "غیرفعال‌سازی" : "فعال‌سازی"}</button>` +
    `<button class="mini-button danger" type="button" data-category-delete="${category.id}">حذف</button>` +
    `</div></div>`
  );
}

function renderCategories() {
  const panel = document.getElementById("categories-list");
  const items = state.categoryAdmin.items;
  panel.innerHTML = items.length
    ? items
        .map((category, index) => categoryRow(category, index, items.length))
        .join("")
    : '<p class="empty-panel">هنوز دسته‌بندی‌ای ثبت نشده است. با «دسته‌بندی تازه» نخستین مورد را بسازید.</p>';
}

async function loadCategories() {
  const panel = document.getElementById("categories-list");
  if (!state.categoryAdmin.items.length)
    panel.innerHTML = '<p class="empty-panel">در حال دریافت فهرست…</p>';
  try {
    const { categories } = await api("/api/admin/categories?manage=1");
    state.categoryAdmin.items = categories;
    state.categories = categories; // the news editor's dropdown uses the same list
    renderCategories();
  } catch (error) {
    panel.innerHTML = `<p class="empty-panel">${escapeHtml(error.message)}</p>`;
  }
}

async function submitCategory(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.getElementById("category-error");
  message.textContent = "";
  try {
    await api("/api/admin/categories", {
      method: "POST",
      body: { name: form.elements.name.value },
    });
    form.hidden = true;
    form.reset();
    showToast("دسته‌بندی افزوده شد.");
    await loadCategories();
  } catch (error) {
    message.textContent = error.message;
  }
}

async function saveCategoryName(form) {
  const id = Number(form.dataset.categoryForm);
  const current = state.categoryAdmin.items.find((item) => item.id === id);
  const name = form.elements.name.value.trim();
  if (!current || name === current.name) {
    state.categoryAdmin.editing = null;
    renderCategories();
    return;
  }
  try {
    await api(`/api/admin/categories/${id}`, {
      method: "PATCH",
      body: { name },
    });
    state.categoryAdmin.editing = null;
    showToast("نام دسته‌بندی ذخیره شد.");
    await loadCategories();
  } catch (error) {
    showToast(error.message);
  }
}

async function moveCategory(id, direction) {
  const ids = state.categoryAdmin.items.map((item) => item.id);
  const index = ids.indexOf(id);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= ids.length) return;
  [ids[index], ids[target]] = [ids[target], ids[index]];
  try {
    await api("/api/admin/categories/reorder", {
      method: "POST",
      body: { ids },
    });
    await loadCategories();
  } catch (error) {
    showToast(error.message);
  }
}

async function toggleCategory(id) {
  const current = state.categoryAdmin.items.find((item) => item.id === id);
  if (!current) return;
  try {
    await api(`/api/admin/categories/${id}`, {
      method: "PATCH",
      body: { is_active: !current.is_active },
    });
    showToast(
      current.is_active ? "دسته‌بندی غیرفعال شد." : "دسته‌بندی فعال شد.",
    );
    await loadCategories();
  } catch (error) {
    showToast(error.message);
  }
}

async function deleteCategory(id) {
  const current = state.categoryAdmin.items.find((item) => item.id === id);
  if (!current) return;
  const detail = current.news_count
    ? `${faDigits.format(current.news_count)} خبر با این دسته‌بندی حذف نمی‌شوند و فقط «بدون دسته‌بندی» می‌شوند.`
    : "این دسته‌بندی خبری ندارد.";
  if (
    !(await confirmDialog({
      title: `حذف «${current.name}»؟`,
      text: detail,
      tone: "danger",
      confirmText: "بله، حذف شود",
    }))
  )
    return;
  try {
    await api(`/api/admin/categories/${id}`, { method: "DELETE", body: {} });
    showToast("دسته‌بندی حذف شد.");
    await loadCategories();
  } catch (error) {
    showToast(error.message);
  }
}

function bindCategoryEvents() {
  document
    .getElementById("new-category-button")
    .addEventListener("click", () => {
      const form = document.getElementById("category-form");
      form.hidden = false;
      form.reset();
      document.getElementById("category-error").textContent = "";
      form.elements.name.focus();
    });
  document
    .getElementById("category-form")
    .addEventListener("submit", submitCategory);
  const list = document.getElementById("categories-list");
  list.addEventListener("click", (event) => {
    const edit = event.target.closest("[data-category-edit]");
    if (edit) {
      state.categoryAdmin.editing = Number(edit.dataset.categoryEdit);
      renderCategories();
      list.querySelector(".category-edit input")?.focus();
      return;
    }
    if (event.target.closest("[data-category-cancel]")) {
      state.categoryAdmin.editing = null;
      renderCategories();
      return;
    }
    const move = event.target.closest("[data-category-move]");
    if (move) {
      moveCategory(Number(move.dataset.categoryId), move.dataset.categoryMove);
      return;
    }
    const toggle = event.target.closest("[data-category-toggle]");
    if (toggle) {
      toggleCategory(Number(toggle.dataset.categoryToggle));
      return;
    }
    const remove = event.target.closest("[data-category-delete]");
    if (remove) deleteCategory(Number(remove.dataset.categoryDelete));
  });
  list.addEventListener("submit", (event) => {
    const form = event.target.closest("[data-category-form]");
    if (!form) return;
    event.preventDefault();
    saveCategoryName(form);
  });
}

// ---------- Automatic portal news ----------
function describePortalRun(run) {
  if (!run) return "هنوز اجرایی ثبت نشده است.";
  const when = formatDate(run.at);
  if (run.error) return `آخرین اجرا (${when}) ناموفق بود: ${run.error}`;
  return `آخرین اجرا: ${when} · ${faDigits.format(run.created)} خبر تازه از ${faDigits.format(run.total)} خبر صفحهٔ پورتال`;
}

// The sentence under the portal switch is built from what the server really does, so it cannot drift from the code.
function describePortalSource(status) {
  let place = "پراکسی رادیو";
  try {
    const url = new URL(status.source);
    place = `پراکسی رادیو (${url.host}${url.pathname})`;
  } catch {}
  const schedule =
    status.mode === "external"
      ? "زمان‌بندی را سیستم‌عامل یا Docker انجام می‌دهد (cron/systemd)"
      : "هر ۱۰ دقیقه خودکار";
  return `خبرهای «اخبار اصلی» pnu.ac.ir از ${place} خوانده می‌شود (${schedule})؛ در هر بار حداکثر ${faDigits.format(status.limit || 20)} خبر بررسی و خبرهای تازه به‌عنوان خبر سراسری و با نام «ربات خبرخوان» منتشر می‌شود. شمار خبرِ بررسی‌شده همان است که پراکسی برمی‌گرداند و در سطر «آخرین اجرا» می‌بینید. کارت این خبرها لینک پورتال را باز می‌کند و ویرایش‌پذیر نیست. دکمهٔ «همین حالا بگیر» با همان پراکسی و همان کد زمان‌بند کار می‌کند.`;
}

async function loadPortalStatus() {
  try {
    const status = await api("/api/admin/portal-news");
    document.getElementById("portal-description").textContent =
      describePortalSource(status);
    document.getElementById("portal-enabled").checked = status.enabled;
    document.getElementById("portal-status").textContent = describePortalRun(
      status.last_run,
    );
  } catch (error) {
    document.getElementById("portal-status").textContent = error.message;
  }
}

async function togglePortal(event) {
  try {
    await api("/api/admin/portal-news", {
      method: "POST",
      body: { enabled: event.target.checked },
    });
    showToast(
      event.target.checked
        ? "دریافت خودکار خبر فعال شد."
        : "دریافت خودکار خبر خاموش شد.",
    );
  } catch (error) {
    event.target.checked = !event.target.checked;
    showToast(error.message);
  }
}

async function runPortal(event) {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "در حال دریافت…";
  try {
    const status = await api("/api/admin/portal-news", {
      method: "POST",
      body: { run: true },
    });
    document.getElementById("portal-status").textContent = describePortalRun(
      status.last_run,
    );
    document.getElementById("portal-description").textContent =
      describePortalSource(status);
    showToast(
      status.result?.error
        ? "دریافت ناموفق بود."
        : `${faDigits.format(status.result?.created ?? 0)} خبر تازه دریافت شد.`,
    );
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "همین حالا بگیر";
  }
}

async function testNowPlaying(event) {
  const button = event.currentTarget;
  const result = document.getElementById("radio-nowplaying-result");
  const form = document.getElementById("settings-form");
  button.disabled = true;
  button.textContent = "در حال آزمایش…";
  result.hidden = false;
  result.textContent = "در حال خواندن از سرور برنامه…";
  try {
    const answer = await api("/api/admin/radio/nowplaying-test", {
      method: "POST",
      body: {
        url: form.elements.radio_nowplaying_url.value.trim(),
        stream_url: form.elements.radio_stream_url.value.trim(),
      },
    });
    if (!answer.ok) result.textContent = `ناموفق: ${answer.error}`;
    else if (!answer.now_playing)
      result.textContent =
        "پاسخ دریافت شد ولی آهنگی در آن پیدا نشد؛ قالب پاسخ یا نشانی ایستگاه را بررسی کنید.";
    else
      result.textContent = `موفق: ${answer.now_playing.title || "—"}${answer.now_playing.artist ? ` — ${answer.now_playing.artist}` : ""}`;
  } catch (error) {
    result.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = "آزمایش اکنون‌پخش";
  }
}

async function loadSettings() {
  loadPortalStatus();
  try {
    const { settings } = await api("/api/admin/settings");
    state.settings = settings;
    const form = document.getElementById("settings-form");
    for (const key of [
      "site_title",
      "radio_title",
      "radio_stream_url",
      "radio_nowplaying_url",
      "max_city_admins",
    ]) {
      form.elements[key].value = settings[key] ?? "";
    }
    form.elements.radio_enabled.checked = settings.radio_enabled === "1";
    form.elements.byline_show_person.checked =
      settings.byline_show_person === "1";
    form.elements.peer_edit_enabled.checked =
      settings.peer_edit_enabled === "1";
    document.getElementById("settings-error").textContent = "";
  } catch (error) {
    document.getElementById("settings-error").textContent = error.message;
  }
}

async function saveSettings(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const error = document.getElementById("settings-error");
  error.textContent = "";
  try {
    const result = await api("/api/admin/settings", {
      method: "PUT",
      body: {
        site_title: form.elements.site_title.value,
        radio_enabled: form.elements.radio_enabled.checked ? "1" : "0",
        radio_title: form.elements.radio_title.value,
        radio_stream_url: form.elements.radio_stream_url.value,
        radio_nowplaying_url: form.elements.radio_nowplaying_url.value,
        byline_show_person: form.elements.byline_show_person.checked
          ? "1"
          : "0",
        max_city_admins: Number(form.elements.max_city_admins.value),
        peer_edit_enabled: form.elements.peer_edit_enabled.checked ? "1" : "0",
      },
    });
    state.settings = result.settings;
    showToast("تنظیمات ذخیره شد.");
  } catch (failure) {
    error.textContent = failure.message;
  }
}

async function testRadio() {
  const form = document.getElementById("settings-form");
  const audio = document.getElementById("radio-test-audio");
  const url = form.elements.radio_stream_url.value.trim();
  if (!url) {
    showToast("ابتدا نشانی پخش را وارد کنید.");
    return;
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    showToast("نشانی پخش معتبر نیست.");
    return;
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  ) {
    showToast("فقط نشانی HTTP یا HTTPS بدون اطلاعات ورود پذیرفته می‌شود.");
    return;
  }
  if (location.protocol === "https:" && parsed.protocol === "http:") {
    showToast(
      "در سایت امن HTTPS، نشانی HTTP به‌دلیل محتوای ناامن قابل آزمایش نیست.",
    );
    return;
  }
  audio.pause();
  audio.src = url;
  audio.hidden = false;
  audio.preload = "none";
  try {
    await audio.play();
  } catch {
    showToast("پخش آغاز نشد؛ نشانی و دسترسی شبکه را بررسی کنید.");
  }
}

async function loadAudit(page = state.auditPage) {
  state.auditPage = page;
  const panel = document.getElementById("audit-list");
  const params = new URLSearchParams({ limit: "20", page: String(page) });
  try {
    const data = await api(`/api/admin/audit?${params}`);
    const { items } = data;
    state.auditPage = data.page;
    const markup = items.length
      ? `<table class="table"><thead><tr><th>زمان</th><th>عامل</th><th>رویداد</th><th>موجودیت</th><th>شناسه</th><th>IP</th></tr></thead><tbody>${items.map((item) => `<tr><td>${formatDate(item.created_at)}</td><td>${escapeHtml(item.actor_username || "سامانه")}</td><td>${escapeHtml(auditAction(item.action))}</td><td>${escapeHtml(entityLabel(item.entity))}</td><td>${item.entity_id ? faDigits.format(item.entity_id) : "—"}</td><td dir="ltr">${escapeHtml(item.ip || "—")}</td></tr>`).join("")}</tbody></table>`
      : '<p class="empty-panel">رویدادی ثبت نشده است.</p>';
    panel.innerHTML = markup;
    renderPager(document.getElementById("audit-pager"), data);
  } catch (error) {
    panel.innerHTML = `<p class="empty-panel">${escapeHtml(error.message)}</p>`;
  }
}

function entityLabel(entity) {
  return (
    {
      news: "خبر",
      user: "کاربر",
      region: "مرکز یا واحد",
      settings: "تنظیمات",
      category: "دسته‌بندی",
    }[entity] || "سامانه"
  );
}

function auditAction(action) {
  const labels = {
    "auth.login": "ورود",
    "auth.logout": "خروج",
    "auth.login_failed": "ورود ناموفق",
    "news.create": "ساخت خبر",
    "news.update": "ویرایش خبر",
    "news.delete": "حذف خبر",
    "news.publish": "انتشار خبر",
    "news.schedule": "زمان‌بندی خبر",
    "news.unpublish": "لغو انتشار",
    "user.create": "ساخت کاربر",
    "user.deactivate": "غیرفعال‌سازی کاربر",
    "user.activate": "فعال‌سازی کاربر",
    "user.delete": "حذف کاربر",
    "settings.update": "تغییر تنظیمات",
    "region.update": "ویرایش مرکز یا واحد",
    "region.create": "افزودن مرکز یا واحد",
    "category.create": "افزودن دسته‌بندی",
    "category.update": "ویرایش دسته‌بندی",
    "category.reorder": "تغییر ترتیب دسته‌بندی‌ها",
    "category.delete": "حذف دسته‌بندی",
    "news.attachment_add": "افزودن پیوست",
    "news.attachment_delete": "حذف پیوست",
  };
  return labels[action] || "رویداد دیگر";
}

async function loadStats() {
  try {
    const data = await api("/api/admin/stats");
    const stats = [
      ["بازدید کل", data.counts.views],
      ["خبر منتشرشده", data.counts.published],
      ["پیش‌نویس", data.counts.draft],
      ["زمان‌بندی‌شده", data.counts.scheduled],
    ];
    document.getElementById("stats-counts").innerHTML = stats
      .map(
        ([label, count]) =>
          `<article class="stat-card"><span>${label}</span><strong>${faDigits.format(count)}</strong></article>`,
      )
      .join("");
    document.getElementById("most-viewed").innerHTML = data.most_viewed.length
      ? data.most_viewed
          .map(
            (item, index) =>
              `<article class="compact-item"><div class="compact-item-main"><strong>${faDigits.format(index + 1)}. ${escapeHtml(item.title)}</strong><small>${statusLabel(item.status)} · ${faDigits.format(item.view_count)} بازدید</small></div><meter min="0" max="${Math.max(1, data.most_viewed[0]?.view_count || 1)}" value="${Number(item.view_count)}"></meter></article>`,
          )
          .join("")
      : '<p class="empty-panel">آماری برای نمایش وجود ندارد.</p>';
  } catch (error) {
    showToast(error.message);
  }
}

async function loadProfile() {
  document.getElementById("profile-password-form")?.reset();
  document.getElementById("profile-password-error").textContent = "";
  try {
    const [me, deviceResponse] = await Promise.all([
      api("/api/auth/me"),
      api("/api/auth/devices"),
    ]);
    state.user = me.user;
    const profile = document.getElementById("profile-details");
    profile.innerHTML = `<dt>نام</dt><dd>${escapeHtml(me.user.full_name)}</dd><dt>نام کاربری</dt><dd>${escapeHtml(me.user.username)}</dd><dt>نقش</dt><dd>${roleLabel(me.user.role)}</dd><dt>محدوده</dt><dd>${escapeHtml(regionName(me.user.region_id))}</dd>`;
    document.getElementById("device-list").innerHTML = deviceResponse.devices
      .length
      ? deviceResponse.devices
          .map(
            (device) =>
              `<div class="compact-item"><div class="compact-item-main"><strong>${escapeHtml(device.user_agent || "دستگاه نامشخص")}</strong><small>${formatDate(device.last_used_at || device.created_at)} · پایان ${formatDate(device.expires_at)}</small></div></div>`,
          )
          .join("")
      : '<p class="muted">دستگاه مورداعتمادی ثبت نشده است.</p>';
  } catch (error) {
    showToast(error.message);
  }
}

async function openAdminNews(id) {
  try {
    const { item } = await api(`/api/admin/news/${id}`);
    showMessage(
      item.title,
      `${item.publisher_unit || ""} · ${formatDate(item.published_at)} · ${faDigits.format(item.view_count)} بازدید`,
    );
    const content = document.getElementById("message-content");
    content.insertAdjacentHTML(
      "beforeend",
      `<div class="admin-news-body">${item.body_html}</div>`,
    );
    if (item.can_edit)
      content.insertAdjacentHTML(
        "beforeend",
        `<button class="button primary" type="button" data-action="edit-news" data-id="${Number(item.id)}">ویرایش خبر</button>`,
      );
  } catch (error) {
    showToast(error.message);
  }
}

async function removeAttachment(button) {
  if (
    !(await confirmDialog({
      title: "حذف پیوست؟",
      text: "این پیوست از خبر حذف می‌شود.",
      tone: "danger",
      confirmText: "بله، حذف شود",
    }))
  )
    return;
  try {
    await api(
      `/api/admin/attachments/${Number(button.dataset.removeAttachment)}`,
      { method: "DELETE", body: {} },
    );
    await openEditor(
      Number(document.querySelector('#news-editor [name="news_id"]').value),
    );
    showToast("پیوست حذف شد.");
  } catch (error) {
    showToast(error.message);
  }
}

async function deleteEditorNews() {
  const id = Number(
    document.querySelector('#news-editor [name="news_id"]').value,
  );
  if (
    !id ||
    !(await confirmDialog({
      title: "حذف خبر؟",
      text: "خبر حذف می‌شود و دیگر در سایت نمایش داده نخواهد شد.",
      tone: "danger",
      confirmText: "بله، حذف شود",
    }))
  )
    return;
  try {
    await api(`/api/admin/news/${id}`, { method: "DELETE", body: {} });
    showToast("خبر حذف شد.");
    goToView(editorReturnView());
  } catch (error) {
    showToast(error.message);
  }
}

async function unpublishEditorNews() {
  const id = Number(
    document.querySelector('#news-editor [name="news_id"]').value,
  );
  if (!id) return;
  try {
    await api(`/api/admin/news/${id}/unpublish`, { method: "POST", body: {} });
    showToast("انتشار خبر لغو شد.");
    await openEditor(id);
  } catch (error) {
    showToast(error.message);
  }
}

function showBackupCodes(codes) {
  document.getElementById("backup-codes").innerHTML = codes
    .map((code) => `<li>${escapeHtml(code)}</li>`)
    .join("");
  showAuth("backup-card");
}

async function onLogin(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const error = document.getElementById("login-error");
  error.textContent = "";
  try {
    const result = await api("/api/auth/login", {
      method: "POST",
      body: {
        username: form.elements.username.value,
        password: form.elements.password.value,
      },
    });
    if (result.next === "totp_setup") {
      const setup = await api("/api/auth/totp/setup");
      const svg = new TextEncoder().encode(setup.qr_svg);
      let binary = "";
      for (const byte of svg) binary += String.fromCharCode(byte);
      document.getElementById("totp-qr").src =
        `data:image/svg+xml;base64,${btoa(binary)}`;
      document.getElementById("totp-secret").textContent = setup.secret;
      document.getElementById("totp-title").textContent = "ثبت برنامهٔ رمزساز";
      document.getElementById("totp-description").textContent =
        "کد QR را با برنامهٔ رمزساز اسکن کنید و کد شش‌رقمی را وارد کنید.";
      document.getElementById("totp-setup").hidden = false;
      document.getElementById("remember-label").hidden = true;
      state.setupRequired = true;
      showAuth("totp-card");
    } else if (result.next === "totp") {
      document.getElementById("totp-title").textContent = "تأیید دومرحله‌ای";
      document.getElementById("totp-description").textContent =
        "کد شش‌رقمی یا یکی از کدهای بازیابی را وارد کنید.";
      document.getElementById("totp-setup").hidden = true;
      document.getElementById("remember-label").hidden = false;
      state.setupRequired = false;
      showAuth("totp-card");
    } else if (result.ok) await finishAuthenticatedLogin(result);
  } catch (failure) {
    error.textContent = failure.message;
  }
}

async function onTotp(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const error = document.getElementById("totp-error");
  error.textContent = "";
  try {
    const code = normalizeDigits(form.elements.code.value.trim());
    const result = state.setupRequired
      ? await api("/api/auth/totp/enable", { method: "POST", body: { code } })
      : await api("/api/auth/totp", {
          method: "POST",
          body: { code, remember: form.elements.remember.checked },
        });
    if (result.backup_codes?.length) {
      showBackupCodes(result.backup_codes);
      return;
    }
    await finishAuthenticatedLogin(result);
  } catch (failure) {
    error.textContent = failure.message;
  }
}

async function finishAuthenticatedLogin(result) {
  if (result.must_change_password) {
    showAuth("password-card");
    return;
  }
  const me = await api("/api/auth/me");
  state.user = me.user;
  if (me.user.must_change_password) {
    showAuth("password-card");
    return;
  }
  closeAuthAndShowAdmin();
  await prepareWorkspace();
}

async function submitPasswordChange(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const error = document.getElementById("password-error");
  error.textContent = "";
  try {
    await api("/api/auth/change-password", {
      method: "POST",
      body: {
        old_password: form.elements.old_password.value,
        new_password: form.elements.new_password.value,
      },
    });
    showToast("گذرواژه تغییر کرد؛ دوباره وارد شوید.");
    showAuth("login-card");
  } catch (failure) {
    error.textContent = failure.message;
  }
}

async function submitProfilePasswordChange(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const error = document.getElementById("profile-password-error");
  error.textContent = "";
  const {
    old_password: oldPassword,
    new_password: newPassword,
    confirm_password: confirmPassword,
  } = form.elements;
  if (newPassword.value !== confirmPassword.value) {
    error.textContent = "تکرار گذرواژهٔ تازه با گذرواژهٔ تازه یکی نیست.";
    return;
  }
  if (newPassword.value === oldPassword.value) {
    error.textContent = "گذرواژهٔ تازه باید با گذرواژهٔ فعلی متفاوت باشد.";
    return;
  }
  try {
    await api("/api/auth/change-password", {
      method: "POST",
      body: {
        old_password: oldPassword.value,
        new_password: newPassword.value,
      },
    });
    form.reset();
    state.user = null; // the server ended every session of this user
    showToast("گذرواژه تغییر کرد؛ دوباره وارد شوید.");
    showAuth("login-card");
  } catch (failure) {
    error.textContent = failure.message;
  }
}

async function logout() {
  try {
    await api("/api/auth/logout", { method: "POST", body: {} });
  } catch {}
  state.user = null;
  showAuth("login-card");
}

function closeMessage(event) {
  if (
    event.target === document.getElementById("message-dialog") ||
    event.target.closest("[data-close-message]")
  ) {
    document.getElementById("message-dialog").close();
  }
}

function bindEvents() {
  document.getElementById("login-form").addEventListener("submit", onLogin);
  document.getElementById("totp-form").addEventListener("submit", onTotp);
  document
    .getElementById("password-form")
    .addEventListener("submit", submitPasswordChange);
  document
    .getElementById("profile-password-form")
    .addEventListener("submit", submitProfilePasswordChange);
  document
    .getElementById("backup-continue")
    .addEventListener("click", async () => {
      const me = await api("/api/auth/me");
      state.user = me.user;
      if (me.user.must_change_password) showAuth("password-card");
      else {
        closeAuthAndShowAdmin();
        await prepareWorkspace();
      }
    });
  document.getElementById("logout-button").addEventListener("click", logout);
  document
    .getElementById("logout-everywhere")
    .addEventListener("click", async () => {
      if (
        !(await confirmDialog({
          title: "خروج از همهٔ دستگاه‌ها؟",
          text: "نشست‌ها و دستگاه‌های مورداعتماد همه‌جا لغو می‌شوند.",
          tone: "warning",
          confirmText: "بله، لغو شود",
        }))
      )
        return;
      try {
        await api("/api/auth/devices", { method: "DELETE", body: {} });
      } catch (error) {
        showToast(error.message);
      }
      showAuth("login-card");
    });
  document
    .getElementById("news-editor")
    .addEventListener("submit", handleEditorSubmit);
  // The quick-news screen exists only on phones: when the window grows to desktop size (or a phone is rotated wide),
  // move to a screen that exists there instead of leaving a blank page. Going back to phone size maps desktop screens
  // to the quick-news screen through goToView().
  matchMedia("(max-width: 767px)").addEventListener("change", (event) => {
    if (!state.user) return;
    const current = state.activeView;
    if (event.matches) goToView(current || "dashboard");
    else if (current === "mobile-compose") goToView("dashboard");
    else if (current === "mobile-recent") goToView("news");
  });
  document
    .getElementById("quick-form")
    .addEventListener("submit", submitQuickCompose);
  const quickForm = document.getElementById("quick-form");
  quickForm.addEventListener("input", renderQuickPreview);
  quickForm.elements.cover.addEventListener("change", (event) =>
    setQuickCover(event.target.files[0] ?? null),
  );
  document
    .getElementById("quick-attachment-remove")
    .addEventListener("click", () => {
      quickForm.elements.cover.value = "";
      setQuickCover(null);
    });
  document.getElementById("user-form").addEventListener("submit", submitUser);
  document
    .getElementById("region-form")
    .addEventListener("submit", submitRegion);
  document
    .getElementById("settings-form")
    .addEventListener("submit", saveSettings);
  bindCategoryEvents();
  bindUploadZones();
  document
    .getElementById("portal-enabled")
    .addEventListener("change", togglePortal);
  document.getElementById("portal-run").addEventListener("click", runPortal);
  document.getElementById("radio-test").addEventListener("click", testRadio);
  document
    .getElementById("radio-nowplaying-test")
    .addEventListener("click", testNowPlaying);
  document
    .getElementById("news-filter-button")
    .addEventListener("click", () => loadNewsList(1));
  const pagerHandlers = {
    "news-pager": (page) => loadNewsList(page),
    "users-pager": (page) => loadUsers(page),
    "audit-pager": (page) => loadAudit(page),
    "mobile-recent-pager": (page) => loadMobileNews("mine", page),
    "mobile-feed-pager": (page) => loadMobileNews("all", page),
  };
  for (const [id, load] of Object.entries(pagerHandlers)) {
    const element = document.getElementById(id);
    element.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-page]");
      if (!button || button.disabled) return;
      await load(Number(button.dataset.page));
      scrollToList(element);
    });
  }
  document
    .getElementById("editor-publish")
    .addEventListener("click", () => publishEditor());
  document
    .querySelectorAll('#news-editor input[name="schedule_mode"]')
    .forEach((radio) =>
      radio.addEventListener("change", () => {
        if (radio.checked && radio.value === "now") {
          state.newsDates.published_at = null;
          updateDateLabel("published_at");
        }
        setEditorMode(state.currentNews?.status);
        if (
          radio.checked &&
          radio.value === "later" &&
          !state.newsDates.published_at
        )
          showCalendar("published_at");
      }),
    );
  for (const type of ["change", "input", "click"])
    document.addEventListener(type, handleTargetPickerEvent);
  document
    .getElementById("editor-delete")
    .addEventListener("click", deleteEditorNews);
  document
    .getElementById("editor-unpublish")
    .addEventListener("click", unpublishEditorNews);
  document
    .getElementById("new-user-button")
    .addEventListener("click", openUserForm);
  document
    .querySelector('#user-form [name="role"]')
    .addEventListener("change", fillUserRegions);
  document
    .querySelector('#user-form [name="province_id"]')
    .addEventListener("change", fillUserRegions);
  document.getElementById("new-region-button").addEventListener("click", () => {
    document.getElementById("region-form").hidden = false;
    populateRegionParents();
  });
  document
    .querySelector('#region-form [name="type"]')
    .addEventListener("change", populateRegionParents);
  initRichEditor({
    editor: document.getElementById("editor-body"),
    toolbar: document.querySelector(".rich-toolbar"),
    askLink: () =>
      promptDialog({
        title: "افزودن پیوند",
        text: "نشانی پیوند را وارد کنید.",
        input: { type: "url", dir: "ltr", placeholder: "https://" },
      }),
  });
  document.getElementById("jalali-prev").addEventListener("click", () => {
    state.calendar.month -= 1;
    if (state.calendar.month < 1) {
      state.calendar.month = 12;
      state.calendar.year -= 1;
    }
    state.calendar.day = Math.min(
      state.calendar.day,
      jalaliMonthLength(state.calendar.year, state.calendar.month),
    );
    renderCalendar();
  });
  document.getElementById("jalali-next").addEventListener("click", () => {
    state.calendar.month += 1;
    if (state.calendar.month > 12) {
      state.calendar.month = 1;
      state.calendar.year += 1;
    }
    state.calendar.day = Math.min(
      state.calendar.day,
      jalaliMonthLength(state.calendar.year, state.calendar.month),
    );
    renderCalendar();
  });
  document.getElementById("jalali-days").addEventListener("click", (event) => {
    const button = event.target.closest("[data-calendar-day]");
    if (!button) return;
    state.calendar.day = Number(button.dataset.calendarDay);
    renderCalendar();
  });
  document
    .getElementById("jalali-apply")
    .addEventListener("click", applyCalendarDate);
  document
    .querySelectorAll("[data-close-jalali]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        document.getElementById("jalali-dialog").close(),
      ),
    );
  document
    .querySelectorAll("[data-jalali-for]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        showCalendar(button.dataset.jalaliFor),
      ),
    );
  document.querySelectorAll("[data-clear-date]").forEach((button) =>
    button.addEventListener("click", () => {
      const field = button.dataset.clearDate;
      state.newsDates[field] = null;
      updateDateLabel(field);
    }),
  );
  document
    .getElementById("message-dialog")
    .addEventListener("click", closeMessage);
  document
    .getElementById("message-dialog")
    .querySelectorAll("[data-close-message]")
    .forEach((button) => button.addEventListener("click", closeMessage));
  const showThemeIcons = () => {
    const dark = document.documentElement.dataset.theme === "dark";
    document.querySelectorAll(".theme-toggle").forEach((button) => {
      button
        .querySelector("use")
        .setAttribute("href", dark ? "#icon-sun" : "#icon-moon");
      button.setAttribute(
        "aria-label",
        dark ? "تغییر به حالت روشن" : "تغییر به حالت تیره",
      );
    });
  };
  showThemeIcons();
  const toggleTheme = () => {
    const next =
      document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("pnu.theme", next);
    } catch {}
    showThemeIcons();
  };
  document.getElementById("admin-theme").addEventListener("click", toggleTheme);
  document.getElementById("auth-theme").addEventListener("click", toggleTheme);
  document.getElementById("desktop-nav").addEventListener("click", (event) => {
    const button = event.target.closest("[data-view]");
    if (button) goToViewGuarded(button.dataset.view);
  });
  document.getElementById("mobile-nav").addEventListener("click", (event) => {
    const button = event.target.closest("[data-view]");
    if (button) goToViewGuarded(button.dataset.view);
  });
  // Closing or reloading the tab with an unsaved news asks the browser to confirm as well.
  window.addEventListener("beforeunload", (event) => {
    if (!editorIsDirty()) return;
    event.preventDefault();
    event.returnValue = "";
  });
  document
    .querySelector(".admin-content")
    .addEventListener("click", (event) => {
      const viewButton = event.target.closest("[data-view-link]");
      if (viewButton) return goToView(viewButton.dataset.viewLink);
      const newButton = event.target.closest('[data-action="new-news"]');
      if (newButton) return resetEditor();
      const backButton = event.target.closest('[data-action="back-news"]');
      if (backButton) return goToViewGuarded(editorReturnView());
      const editButton = event.target.closest('[data-action="edit-news"]');
      if (editButton) return openEditor(Number(editButton.dataset.id));
      const removeButton = event.target.closest("[data-remove-attachment]");
      if (removeButton) return removeAttachment(removeButton);
      const userAction = event.target.closest("[data-user-action]");
      if (userAction) return handleUserAction(userAction);
      if (event.target.closest('[data-action="cancel-user"]'))
        document.getElementById("user-form").hidden = true;
      if (event.target.closest('[data-action="cancel-region"]'))
        document.getElementById("region-form").hidden = true;
      if (event.target.closest('[data-action="cancel-category"]'))
        document.getElementById("category-form").hidden = true;
    });
  const regionsTree = document.getElementById("regions-tree");
  regionsTree.addEventListener("click", (event) => {
    const edit = event.target.closest("[data-unit-edit]");
    if (edit) {
      event.preventDefault();
      state.units.editing = Number(edit.dataset.unitEdit);
      renderUnits();
      document.querySelector('.unit-edit input[name="name"]')?.focus();
      return;
    }
    if (event.target.closest("[data-unit-cancel]")) {
      event.preventDefault();
      state.units.editing = null;
      renderUnits();
    }
  });
  regionsTree.addEventListener("submit", (event) => {
    const form = event.target.closest("[data-unit-form]");
    if (!form) return;
    event.preventDefault();
    saveUnit(form);
  });
  regionsTree.addEventListener("click", (event) => {
    const summary = event.target.closest("summary");
    if (!summary || event.target.closest("button, input, select, textarea, a"))
      return;
    const province = summary.closest("[data-province]");
    if (!province) return;
    const id = Number(province.dataset.province);
    // the browser toggles `open` after this handler, so the new state is the opposite of the current one
    if (province.open) state.units.open.delete(id);
    else state.units.open.add(id);
  });
  document
    .getElementById("regions-search")
    .addEventListener("input", renderUnits);
  document
    .getElementById("regions-filter")
    .addEventListener("change", renderUnits);

  document
    .getElementById("message-content")
    .addEventListener("click", async (event) => {
      if (!event.target.closest("[data-copy-secret]")) return;
      const secret =
        document.querySelector(".temp-secret code")?.textContent || "";
      try {
        await navigator.clipboard.writeText(secret);
        showToast("گذرواژه کپی شد.");
      } catch {
        showToast("کپی خودکار در دسترس نیست.");
      }
    });
}

bindEvents();
loadAdmin();
