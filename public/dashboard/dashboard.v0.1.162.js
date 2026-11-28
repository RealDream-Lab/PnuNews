import { initRichEditor } from "/shared/rich-editor.v0.1.162.js";
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
  units: { items: [], users: [], open: new Set(), editing: null, seeded: false },
  categoryAdmin: { items: [], editing: null },
  domainAdmin: { items: [], editing: null },
  uploads: { cover: [], images: [], files: [] },
  uploadSeq: 0,
};
const faCollator = new Intl.Collator("fa", { sensitivity: "base" });
const faDigits = new Intl.NumberFormat("fa-IR");
// 0-9 -> ۰-۹ for numbers shown as text (phone numbers, codes, student numbers); what is stored stays 0-9.
const toFaDigits = (value) => String(value ?? "").replace(/\d/g, (digit) => "۰۱۲۳۴۵۶۷۸۹"[digit]);
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

const COPY_ICON =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15"/></svg>';
const CHECK_ICON =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

// `details` is an optional list of [label, value] rows (e.g. which centre and user a secret belongs to).
function showMessage(title, message, secret = "", details = []) {
  const dialog = document.getElementById("message-dialog");
  const content = document.getElementById("message-content");
  const rows = details.length
    ? `<dl class="message-details">${details.map(([label, value, ltr]) => `<div><dt>${escapeHtml(label)}</dt><dd${ltr ? ' dir="ltr"' : ""}>${escapeHtml(value)}</dd></div>`).join("")}</dl>`
    : "";
  const secretBox = secret
    ? `<div class="temp-secret"><div class="temp-secret-text"><small>گذرواژهٔ موقت</small><code dir="ltr">${escapeHtml(secret)}</code></div><button class="icon-button copy-secret" type="button" data-copy-secret title="کپی گذرواژه" aria-label="کپی گذرواژه">${COPY_ICON}</button></div>`
    : "";
  content.innerHTML = `<p class="eyebrow">اطلاع‌رسانی</p><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p>${rows}${secretBox}`;
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
  installRoot.innerHTML = `<div class="install-banner" role="region" aria-label="نصب برنامه"><img src="/icons/pnu-logo.v3.png" width="40" height="40" alt="" aria-hidden="true"><div class="install-text"><strong>نصب مدیریت خبرها</strong><span>${text}</span></div>${action}<button type="button" class="icon-button" data-install-dismiss aria-label="بستن"><svg class="icon"><use href="#admin-icon-close"/></svg></button></div>`;
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
  setTimeout(() => {
    if (installPrompt) showInstallBanner("prompt");
  }, 3000);
});
window.addEventListener("appinstalled", () => {
  installPrompt = null;
  hideInstallBanner();
});
if (isIos() && !isStandalone())
  setTimeout(() => showInstallBanner("ios"), 4000);

async function runInstall() {
  if (!installPrompt) return;
  const promptEvent = installPrompt;
  installPrompt = null;
  hideInstallBanner();
  try {
    await promptEvent.prompt();
    const { outcome } = await promptEvent.userChoice;
    if (outcome !== "accepted") snoozeInstall();
  } catch {}
}
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
  const centersLabel = document.getElementById("about-centers");
  centersLabel.textContent = "…";
  // Same number the reader shows: the centers a reader can pick (public config, no login needed).
  fetch("/api/public/config", { cache: "no-store" })
    .then((response) => (response.ok ? response.json() : Promise.reject()))
    .then((config) => {
      const count = (config.provinces ?? []).reduce(
        (sum, province) => sum + province.cities.length,
        0,
      );
      centersLabel.textContent = String(count).replace(
        /\d/g,
        (digit) => "۰۱۲۳۴۵۶۷۸۹"[digit],
      );
    })
    .catch(() => {
      centersLabel.textContent = "—";
    });
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

// A drop-down for askDialog: options [{ value, label, group? }]; options with the same group share an <optgroup>.
function selectMarkup({ placeholder = "انتخاب کنید…", options = [] }) {
  const groups = new Map();
  for (const option of options) {
    const key = option.group ?? "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(option);
  }
  const optionHtml = (option) =>
    `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`;
  const body = [...groups]
    .map(([group, items]) =>
      group
        ? `<optgroup label="${escapeHtml(group)}">${items.map(optionHtml).join("")}</optgroup>`
        : items.map(optionHtml).join(""),
    )
    .join("");
  return `<select class="swal-input" aria-label="${escapeHtml(placeholder)}"><option value="" selected disabled>${escapeHtml(placeholder)}</option>${body}</select>`;
}

// SweetAlert-style dialogs (no external library; the CSP only allows our own files).
function askDialog({
  title,
  text = "",
  tone = "warning",
  confirmText = "تأیید",
  cancelText = "انصراف",
  input = null,
  select = null,
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
        ? `<input class="swal-input" type="${input.type || "text"}" dir="${input.dir || "rtl"}" placeholder="${escapeHtml(input.placeholder || "")}" value="${escapeHtml(input.value || "")}" autocomplete="off">`
        : "") +
      (select ? selectMarkup(select) : "") +
      `<div class="swal-actions"><button type="button" class="button ${tone === "danger" ? "danger" : "primary"}" data-swal="confirm">${escapeHtml(confirmText)}</button>` +
      `<button type="button" class="button outline" data-swal="cancel">${escapeHtml(cancelText)}</button></div></div>`;
    const field = dialog.querySelector(".swal-input");
    const isSelect = field?.tagName === "SELECT";
    let result = null;
    const finish = (value) => {
      result = value;
      dialog.close();
    };
    dialog.addEventListener("click", (event) => {
      const action = event.target.closest("[data-swal]")?.dataset.swal;
      if (action === "confirm") {
        // a list without a choice does not confirm
        if (isSelect && !field.value) field.focus();
        else finish(field ? field.value.trim() : true);
      }
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
    const failure = new Error(payload.error || "انجام درخواست ناموفق بود.");
    failure.field = payload.field;
    throw failure;
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

function roleLabel(role, domainName = "") {
  if (role === "domain_user")
    return domainName ? `کاربر حوزه ${domainName}` : "کاربر حوزه";
  return (
    {
      super_admin: "مدیر ارشد",
      country_admin: "روابط عمومی سازمان مرکزی",
      province_admin: "مدیر استان",
      city_admin: "مدیر مرکز دانشگاهی",
    }[role] || "مدیر"
  );
}

// A domain user works at the level of its unit (country / province / city) and publishes like the admin of that level.
function levelRole(user) {
  if (user?.role !== "domain_user") return user?.role;
  return (
    { country: "country_admin", province: "province_admin", city: "city_admin" }[
      user.level
    ] || "city_admin"
  );
}

const UNIT_ADMIN_ROLES = ["country_admin", "province_admin", "city_admin"];
const USERS_VIEW_ROLES = ["super_admin", ...UNIT_ADMIN_ROLES];

function regionName(regionId) {
  return (
    state.regions.find((region) => Number(region.id) === Number(regionId))
      ?.name || ""
  );
}

// The line under the user's name in the sidebar: the unit they belong to (e.g. "دانشگاه پیام‌نور شهر ری").
function userUnitText() {
  const role = levelRole(state.user);
  const domain = state.user?.domain_name
    ? ` · حوزه ${state.user.domain_name}`
    : "";
  if (role === "super_admin" || role === "country_admin")
    return `${roleLabel(role)}${domain}`;
  const region = state.regions.find(
    (item) => Number(item.id) === Number(state.user?.region_id),
  );
  if (!region) return `${roleLabel(role)}${domain}`;
  return `${
    region.type === "province"
      ? `دانشگاه پیام‌نور استان ${region.name}`
      : `دانشگاه پیام‌نور ${region.name}`
  }${domain}`;
}

function setScopeBanner() {
  // The sidebar card shows who is signed in and for which unit.
  document.getElementById("desktop-user-name").textContent =
    state.user?.full_name || "";
  document.getElementById("desktop-user-unit").textContent = userUnitText();
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
  // «مراکز و واحدها» and «مدیریت کاربران» are one page now.
  if (view === "regions") view = "users";
  // The reader accounts are the main admin's alone.
  if (view === "readers" && state.user?.role !== "super_admin") view = "dashboard";
  // Domain users manage nobody and have no event log.
  if (
    (view === "users" || view === "audit") &&
    !USERS_VIEW_ROLES.includes(state.user?.role)
  )
    view = "dashboard";
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
  else if (actualView === "users") loadStructure();
  else if (actualView === "categories") loadCategories();
  else if (actualView === "domains") loadDomains();
  else if (actualView === "readers") loadReaders();
  else if (actualView === "settings") loadSettings();
  else if (actualView === "audit") loadAudit(1);
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

async function prepareWorkspace() {
  const [regions, categories] = await Promise.all([
    api("/api/admin/regions"),
    api("/api/admin/categories"),
  ]);
  state.regions = regions.regions;
  state.categories = categories.categories;
  setScopeBanner();
  beginQuickCompose();
  document.querySelectorAll("[data-super-only]").forEach((element) => {
    element.hidden = state.user.role !== "super_admin";
  });
  document.querySelectorAll("[data-show-roles]").forEach((element) => {
    element.hidden = !element.dataset.showRoles
      .split(",")
      .includes(state.user.role);
  });
  document.querySelectorAll("[data-hide-city]").forEach((element) => {
    element.hidden = state.user.role === "city_admin";
  });
  if (USERS_VIEW_ROLES.includes(state.user.role)) await fillDomainFilter();
  if (matchMedia("(max-width: 767px)").matches) goToView("mobile-compose");
  else goToView("dashboard");
  // "ویرایش کامل در پنل" from the public site's inline editor: /dashboard/?edit=<news id> opens that news here.
  const wanted = Number(new URLSearchParams(location.search).get("edit"));
  if (Number.isSafeInteger(wanted) && wanted > 0) {
    history.replaceState(null, "", location.pathname);
    await openEditor(wanted);
  }
}

// The news list's domain filter: every admin (not domain users) can narrow the list to one work domain.
async function fillDomainFilter() {
  const select = document.getElementById("news-domain");
  try {
    const { domains } = await api("/api/admin/domains");
    select.innerHTML =
      '<option value="">همهٔ حوزه‌ها</option>' +
      domains
        .map(
          (domain) =>
            `<option value="${Number(domain.id)}">${escapeHtml(domain.name)}</option>`,
        )
        .join("");
  } catch {
    select.innerHTML = '<option value="">همهٔ حوزه‌ها</option>';
  }
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

// «مهم» (pin) and «فوری» (urgent) toggles right in the lists, so the news does not have to be opened in the editor.
// They exist only for published news inside the 72-hour window; the server decides that (`flags_expired`) and
// re-checks it on every request.
const FLAG_BUTTONS = [
  ["pin", "is_pinned", "مهم", "خبر مهم (سنجاق)"],
  ["urgent", "is_urgent", "فوری", "خبر فوری"],
];
const FLAG_TOASTS = {
  pin: ["علامت مهم برداشته شد.", "خبر مهم شد."],
  urgent: ["علامت فوری برداشته شد.", "خبر فوری شد."],
};

function flagButtons(item) {
  if (item.status !== "published" || item.flags_expired) return "";
  return FLAG_BUTTONS.map(
    ([flag, field, label, title]) =>
      `<button class="mini-button flag-toggle" type="button" data-action="toggle-flag" data-flag="${flag}" data-id="${Number(item.id)}" aria-pressed="${Boolean(item[field])}" title="${title}">${label}</button>`,
  ).join("");
}

async function toggleFlag(button) {
  if (button.disabled) return;
  const id = Number(button.dataset.id);
  const flag = button.dataset.flag;
  const enable = button.getAttribute("aria-pressed") !== "true";
  button.disabled = true;
  try {
    await api(`/api/admin/news/${id}/${flag}`, {
      method: "POST",
      body: { enabled: enable },
    });
    // The same news can sit in more than one list; update in place (no reload, so the row keeps its position).
    for (const other of document.querySelectorAll(
      `[data-action="toggle-flag"][data-id="${id}"][data-flag="${flag}"]`,
    ))
      other.setAttribute("aria-pressed", String(enable));
    if (flag === "urgent")
      for (const label of document.querySelectorAll(`[data-urgent-for="${id}"]`))
        label.hidden = !enable;
    showToast(FLAG_TOASTS[flag][enable ? 1 : 0]);
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}

function compactNews(item, action = "edit-news") {
  const date = item.published_at || item.updated_at || item.created_at;
  return `<article class="compact-item"><div class="compact-item-main"><strong>${escapeHtml(item.title)}${item.source_url ? ' <span class="auto-badge">خودکار</span>' : ""}</strong><small>${statusLabel(item.status)} · ${formatDate(date)} · ${faDigits.format(item.view_count || 0)} بازدید</small></div><div class="compact-actions">${flagButtons(item)}<button class="mini-button" type="button" data-action="${action}" data-id="${Number(item.id)}">مشاهده</button></div></article>`;
}

function renderNewsTable(items) {
  if (!items.length)
    return '<p class="empty-panel">خبری با این فیلتر پیدا نشد.</p>';
  return `<table class="table"><thead><tr><th>عنوان</th><th>مبدأ و مقصد</th><th>دسته‌بندی</th><th>وضعیت</th><th>بازدید</th><th>آخرین تغییر</th><th></th></tr></thead><tbody>${items
    .map(
      (item) => `<tr>
    <td><strong>${escapeHtml(item.title)}</strong>${item.source_url ? ' <span class="auto-badge">خودکار</span>' : ""}${item.creator_domain_name ? ` <span class="auto-badge">${escapeHtml(item.creator_domain_name)}</span>` : ""}<br><small>${escapeHtml(item.summary || "")}</small></td>
    <td>${escapeHtml(item.origin_region_name)}<br><small>${escapeHtml(scopeLabel(item.targets))}</small></td>
    <td>${escapeHtml(item.category_name || "—")}</td>
    <td><span class="status-badge ${escapeHtml(item.status)}">${statusLabel(item.status)}</span><span class="urgent-label" data-urgent-for="${Number(item.id)}"${item.is_urgent ? "" : " hidden"}> · فوری</span></td>
    <td>${faDigits.format(item.view_count)}</td><td>${formatDate(item.updated_at)}</td>
    <td><div class="compact-actions">${flagButtons(item)}<button class="mini-button" type="button" data-action="edit-news" data-id="${Number(item.id)}">${item.source_url && !FEED_ROLES.includes(state.user.role) ? "مشاهده" : "بازکردن"}</button></div></td>
  </tr>`,
    )
    .join("")}</tbody></table>`;
}

// ---------- Pagination (numbered pages, shared by every long list) ----------
// The arrows are drawn, not typed: the characters › and ‹ are mirrored by the bidi algorithm inside right-to-left text,
// which made them point the wrong way. In this layout "previous" sits on the right and points right, "next" sits on the left.
const PAGER_ARROW_PREVIOUS = '<svg class="pager-arrow" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const PAGER_ARROW_NEXT = '<svg class="pager-arrow" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const PAGE_SIZE = 10;

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
    <button type="button" class="pager-button pager-step" data-page="${page - 1}" ${page <= 1 ? "disabled" : ""}>${PAGER_ARROW_PREVIOUS}<span>قبلی</span></button>
    <div class="pager-numbers">${numbers}</div>
    <button type="button" class="pager-button pager-step" data-page="${page + 1}" ${page >= pages ? "disabled" : ""}><span>بعدی</span>${PAGER_ARROW_NEXT}</button>
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
  const domainFilter = document.getElementById("news-domain").value;
  if (domainFilter) params.set("domain", domainFilter);
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
  const role = levelRole(user);
  if (role === "city_admin")
    return { kind: "city", rootId: Number(user.region_id), options: [] };
  if (role === "super_admin" || role === "country_admin") {
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
  document.getElementById("editor-assign").hidden = true;
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
    // The automatic portal news are edited by the main admin and the central PR only (policy.js canEditNews).
    document.getElementById("editor-heading").textContent = item.source_url
      ? item.can_edit
        ? "ویرایش خبر خودکار پورتال"
        : "خبر خودکار پورتال (فقط خواندنی)"
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
    // For a portal news the media section opens: a cover uploaded here replaces the portal's own picture.
    document.getElementById("editor-media").open = Boolean(
      (item.attachments || []).length || (item.source_url && item.can_edit),
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
    // Only the main admin hands a news to another author; the automatic portal news have none.
    const assign = document.getElementById("editor-assign");
    assign.hidden = !(state.user.role === "super_admin" && !item.source_url);
    assign.disabled = false;
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

// Hand the open news to another author. Targets: active users of the country level and of the province level.
async function assignEditorNews() {
  const id = Number(state.currentNews?.id);
  if (!id || state.busy) return;
  try {
    const { users } = await api("/api/admin/news/assignees");
    const current = Number(state.currentNews.created_by);
    const options = users
      .filter((user) => user.id !== current)
      .map((user) => ({
        value: String(user.id),
        label: `${user.full_name} · ${roleLabel(user.role, user.domain_name)}`,
        group:
          user.region_type === "country"
            ? "سطح کشور"
            : `استان ${user.region_name}`,
      }));
    if (!options.length) {
      showToast("کاربر فعال دیگری در سطح کشور یا استان پیدا نشد.");
      return;
    }
    const choice = await askDialog({
      title: "اختصاص خبر به کاربر دیگر",
      text: `نویسندهٔ فعلی: ${state.currentNews.created_by_name || "—"}. خبر و دسترسی ویرایش آن به کاربر انتخاب‌شده منتقل می‌شود؛ مقصدها و متن خبر تغییری نمی‌کند.`,
      tone: "question",
      confirmText: "اختصاص",
      select: { placeholder: "انتخاب کاربر…", options },
    });
    if (!choice) return;
    const result = await api(`/api/admin/news/${id}/assign`, {
      method: "POST",
      body: { user_id: Number(choice) },
    });
    state.currentNews.created_by = result.user_id;
    state.currentNews.created_by_name = result.full_name;
    showToast(`خبر به «${result.full_name}» اختصاص داده شد.`);
  } catch (error) {
    showToast(error.message);
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
    // "Publish now" sends no time at all: the server stamps its own clock. This browser's clock can run a few seconds
    // ahead of the server's, and a time even slightly in the future turns the news into a scheduled one.
    await api(`/api/admin/news/${id}/publish`, {
      method: "POST",
      body: {
        ...(scheduled ? { published_at: state.newsDates.published_at } : {}),
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

// ---------- Structure and users (one page: every unit with its users) ----------
const UNIT_ADMIN_BY_TYPE = {
  country: "country_admin",
  province: "province_admin",
  city: "city_admin",
};

// The roles the signed-in admin can create inside one unit. Mirrors `canCreateUser` (src/auth/policy.js); the server
// has the last word. A unit takes one active admin, so the admin role is offered only while the unit has none, and the
// main admin adds a centre's admin only under a province that already has one.
function creatableRoles(unit) {
  const actor = state.user.role;
  const roles = [];
  const parent = state.units.items.find((item) => item.id === unit.parent_id);
  const mayAddAdmin =
    (actor === "super_admin" &&
      (unit.type !== "city" || (parent?.active_admins ?? 0) > 0)) ||
    (actor === "country_admin" && unit.type === "province") ||
    (actor === "province_admin" && unit.type === "city");
  if (mayAddAdmin && unit.active_admins === 0)
    roles.push(UNIT_ADMIN_BY_TYPE[unit.type]);
  if (actor !== "super_admin" && unit.id === Number(state.user.region_id))
    roles.push("domain_user");
  return roles;
}

function syncUserFormRole() {
  const form = document.getElementById("user-form");
  document.getElementById("user-domain-label").hidden =
    form.elements.role.value !== "domain_user";
}

async function openUserForm(unitId) {
  const unit = state.units.items.find((item) => item.id === unitId);
  const roles = unit ? creatableRoles(unit) : [];
  if (!roles.length) return;
  const form = document.getElementById("user-form");
  form.reset();
  document.getElementById("user-error").textContent = "";
  form.elements.region_id.value = unit.id;
  form.elements.region_name.value = unit.name;
  form.elements.role.innerHTML = roles
    .map(
      (role) =>
        `<option value="${role}">${role === "domain_user" ? "کاربر حوزه" : escapeHtml(roleLabel(role))}</option>`,
    )
    .join("");
  // The work domains the main admin defined: a unit admin picks one for the new domain user.
  if (roles.includes("domain_user")) {
    try {
      const { domains } = await api("/api/admin/domains");
      const active = domains.filter((domain) => domain.is_active);
      form.elements.domain_id.innerHTML = active
        .map(
          (domain) =>
            `<option value="${Number(domain.id)}">${escapeHtml(domain.name)}</option>`,
        )
        .join("");
      if (!active.length)
        form.elements.role.querySelector('[value="domain_user"]').remove();
    } catch (error) {
      showToast(error.message);
      return;
    }
  }
  if (!form.elements.role.options.length) {
    showToast("هنوز حوزه‌ای تعریف نشده است؛ مدیر ارشد باید حوزه‌ها را بسازد.");
    return;
  }
  syncUserFormRole();
  form.hidden = false;
  form.scrollIntoView({ block: "center", behavior: "smooth" });
  form.elements.full_name.focus({ preventScroll: true });
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
        ...(form.elements.role.value === "domain_user"
          ? { domain_id: Number(form.elements.domain_id.value) }
          : {}),
      },
    });
    form.hidden = true;
    showMessage(
      "کاربر ساخته شد",
      "این گذرواژهٔ موقت فقط همین‌بار نمایش داده می‌شود. آن را از مسیر امن به کاربر تحویل دهید.",
      result.temporary_password,
    );
    await loadStructure();
  } catch (error) {
    message.textContent = error.message;
  }
}

const USERNAME_PATTERN = /^[\p{L}\p{N}_.-]{3,80}$/u;

// Asks for a new username in a dialog; a refused name (taken, invalid) reopens the dialog with the reason.
async function renameUser(button) {
  const id = Number(button.dataset.userId);
  const current = button.dataset.username || "";
  const person = button.dataset.userName || "کاربر";
  const hint =
    "نام کاربری باید در کل کشور یکتا باشد. فقط حرف، رقم و _ . - ؛ ۳ تا ۸۰ نویسه.";
  let value = current;
  let problem = "";
  for (;;) {
    const answer = await promptDialog({
      title: `تغییر نام کاربری «${person}»`,
      text: problem ? `${problem}\n${hint}` : hint,
      confirmText: "ذخیره",
      input: { dir: "ltr", placeholder: "username", value },
    });
    if (answer === null || answer === false) return;
    value = String(answer).trim();
    if (value === current) return;
    if (!USERNAME_PATTERN.test(value)) {
      problem = "نام کاربری معتبر نیست.";
      continue;
    }
    try {
      await api(`/api/admin/users/${id}`, {
        method: "PATCH",
        body: { username: value },
      });
      showToast(`نام کاربری به «${value}» تغییر کرد.`);
      await loadStructure();
      return;
    } catch (error) {
      problem = error.message;
    }
  }
}

// Second question when activating a user: keep the current username or change it too. Returns true when this helper
// finished the job (renamed and activated, or the person gave up) and false when the plain activation should go on.
// The new name travels with the activation request, so both are saved together or neither is: a name the server
// refuses (taken, invalid) reopens the dialog with the reason and the account stays inactive.
async function activateWithUsernameChoice(button) {
  const id = Number(button.dataset.userId);
  const current = button.dataset.username || "";
  const person = button.dataset.userName || "کاربر";
  const wantsChange = await confirmDialog({
    title: "نام کاربری را هم تغییر بدهید؟",
    text: `نام کاربری فعلی «${person}»: ${current}\nاگر «بله» را بزنید، تغییر نام کاربری و فعال‌سازی هم‌زمان انجام می‌شود.`,
    tone: "question",
    confirmText: "بله، تغییر می‌دهم",
    cancelText: "خیر، همین بماند",
  });
  if (!wantsChange) return false;
  const hint =
    "نام کاربری باید در کل کشور یکتا باشد. فقط حرف، رقم و _ . - ؛ ۳ تا ۸۰ نویسه.";
  let value = current;
  let problem = "";
  for (;;) {
    const answer = await promptDialog({
      title: `نام کاربری تازهٔ «${person}»`,
      text: problem ? `${problem}\n${hint}` : hint,
      confirmText: "تغییر و فعال‌سازی",
      input: { dir: "ltr", placeholder: "username", value },
    });
    if (answer === null || answer === false) return true;
    value = String(answer).trim();
    if (value === current) return false;
    if (!USERNAME_PATTERN.test(value)) {
      problem = "نام کاربری معتبر نیست.";
      continue;
    }
    try {
      await api(`/api/admin/users/${id}/activate`, {
        method: "POST",
        body: { username: value },
      });
    } catch (error) {
      if (error.field === "username") {
        problem = error.message;
        continue;
      }
      showToast(error.message);
      return true;
    }
    showToast(`کاربر فعال شد و نام کاربری به «${value}» تغییر کرد.`);
    await loadStructure();
    return true;
  }
}

async function handleUserAction(button) {
  const id = Number(button.dataset.userId);
  const action = button.dataset.userAction;
  if (!id || !action) return;
  if (action === "rename") return renameUser(button);
  const isDelete = action === "delete";
  if (isDelete && Number(button.dataset.subordinates) > 0) {
    showMessage(
      "حذف ممکن نیست",
      `«${button.dataset.userName || "این مدیر"}» هنوز ${faDigits.format(Number(button.dataset.subordinates))} مدیر زیرمجموعه دارد. ابتدا مدیران زیرمجموعه را حذف کنید، سپس این مدیر را حذف کنید.`,
    );
    return;
  }
  const label = button.textContent.trim();
  const isReset = action === "reset-password";
  const confirmed = isDelete
    ? await confirmDialog({
        title: `حذف «${button.dataset.userName || "کاربر"}»؟`,
        text: "این کاربر برای همیشه حذف می‌شود و این کار قابل بازگشت نیست. خبرهایی که او ساخته یا منتشر کرده به مدیر بالادستش منتقل می‌شود.",
        tone: "danger",
        confirmText: "بله، حذف شود",
      })
    : await confirmDialog({
        title: `${label}؟`,
        text: isReset
          ? `برای «${button.dataset.userName || "کاربر"}» یک گذرواژهٔ موقت تازه ساخته می‌شود، ورودهای فعلی او بسته می‌شود و در ورود بعدی باید گذرواژه را عوض کند.`
          : "آیا از انجام این کار مطمئن هستید؟",
        tone: action === "deactivate" ? "warning" : "question",
        confirmText: "بله، انجام شود",
      });
  if (!confirmed) return;
  // Activating asks a second question: change the username too? When the answer is yes the helper does both in one
  // request and we are done; otherwise the plain activation below runs.
  if (action === "activate" && (await activateWithUsernameChoice(button)))
    return;
  try {
    const result = await api(
      isDelete ? `/api/admin/users/${id}` : `/api/admin/users/${id}/${action}`,
      { method: isDelete ? "DELETE" : "POST", body: {} },
    );
    if (result.temporary_password)
      showMessage(
        "گذرواژه بازنشانی شد",
        "این گذرواژهٔ موقت فقط همین‌بار نمایش داده می‌شود؛ آن را از مسیر امن به کاربر تحویل دهید. کاربر در ورود بعدی باید آن را عوض کند.",
        result.temporary_password,
        [
          button.dataset.unitType === "city"
            ? ["دانشگاه", `دانشگاه پیام‌نور ${button.dataset.unitName}`]
            : ["واحد", button.dataset.unitName || "—"],
          ["نام کاربر", button.dataset.userName || "—"],
          ["نام کاربری", button.dataset.username || "—", true],
        ],
      );
    else if (isDelete)
      showToast(
        result.news_transferred > 0
          ? `کاربر حذف شد و ${faDigits.format(result.news_transferred)} خبر به «${result.transferred_to?.full_name || "مدیر بالادست"}» منتقل شد.`
          : "کاربر حذف شد.",
      );
    else showToast("تغییر انجام شد.");
    await loadStructure();
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

function unitState(unit) {
  if (unit.visibility_override === "hide")
    return { key: "hidden", label: "پنهان", active: false };
  if (unit.type === "city") {
    if (unit.active_admins > 0)
      return { key: "active", label: "فعال", active: true };
    if (unit.visibility_override === "show")
      return { key: "forced", label: "نمایش اجباری", active: true };
    return {
      key: "inactive",
      label: unit.admins_total > 0 ? "مدیر غیرفعال" : "بدون مدیر",
      active: false,
    };
  }
  return unit.active_cities > 0
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

// One user under its unit. Instant password reset is for the admins; a domain user keeps the plain reset.
function userRow(user, unit) {
  const id = Number(user.id);
  const mine = id === Number(state.user?.id);
  const admin = UNIT_ADMIN_ROLES.includes(user.role);
  const name = escapeHtml(user.full_name);
  const username = escapeHtml(user.username);
  const badge = user.is_active
    ? ""
    : ' <span class="status-badge draft">غیرفعال</span>';
  const actions = mine
    ? '<span class="muted">حساب شما</span>'
    : `<button class="mini-button" type="button" data-user-action="rename" data-user-id="${id}" data-user-name="${name}" data-username="${username}">تغییر نام کاربری</button>` +
      `<button class="mini-button" type="button" data-user-action="reset-password" data-user-id="${id}" data-user-name="${name}" data-username="${username}" data-unit-name="${escapeHtml(unit.name)}" data-unit-type="${unit.type}">${admin ? "ریست فوری رمز" : "بازنشانی گذرواژه"}</button>` +
      `<button class="mini-button" type="button" data-user-action="reset-2fa" data-user-id="${id}">بازنشانی ۲مرحله‌ای</button>` +
      `<button class="mini-button" type="button" data-user-action="${user.is_active ? "deactivate" : "activate"}" data-user-id="${id}" data-user-name="${name}" data-username="${username}">${user.is_active ? "غیرفعال‌سازی" : "فعال‌سازی"}</button>` +
      (user.role !== "super_admin"
        ? `<button class="mini-button danger" type="button" data-user-action="delete" data-user-id="${id}" data-user-name="${name}" data-subordinates="${Number(user.subordinate_count) || 0}">حذف کاربر</button>`
        : "");
  return `<div class="unit-user${user.is_active ? "" : " is-inactive"}"><div class="unit-user-main"><strong>${name}</strong>${badge}<small>${escapeHtml(roleLabel(user.role, user.domain_name))} · ${username}</small></div><div class="compact-actions">${actions}</div></div>`;
}

function usersBlock(users, unit) {
  return users.length
    ? `<div class="unit-users">${users.map((user) => userRow(user, unit)).join("")}</div>`
    : "";
}

function addUserButton(unit) {
  return creatableRoles(unit).length
    ? `<button class="mini-button" type="button" data-unit-add="${unit.id}">＋ کاربر</button>`
    : "";
}

function cityRow(city, users) {
  if (state.units.editing === city.id)
    return `<div class="unit-row unit-city is-editing">${unitEditForm(city)}</div>`;
  const isSuper = state.user.role === "super_admin";
  const parent = state.units.items.find((item) => item.id === city.parent_id);
  const note =
    city.active_admins > 0
      ? ""
      : city.admins_total > 0
        ? "مدیر این مرکز غیرفعال است"
        : isSuper && (parent?.active_admins ?? 0) === 0
        ? "مدیری ثبت نشده؛ ابتدا مدیر استان را بسازید"
        : "مدیری ثبت نشده";
  const actions =
    addUserButton(city) +
    (isSuper
      ? `<button class="mini-button" type="button" data-unit-edit="${city.id}">ویرایش</button><button class="mini-button danger" type="button" data-unit-delete="${city.id}">حذف</button>`
      : "");
  return `<div class="unit-row unit-city"><div class="unit-main"><span class="unit-name">${escapeHtml(city.name)}</span>${note ? `<small class="muted">${note}</small>` : ""}</div>${unitBadge(unitState(city))}<div class="unit-actions">${actions}</div>${usersBlock(users, city)}</div>`;
}

function renderStructure() {
  const container = document.getElementById("structure-tree");
  const summary = document.getElementById("structure-summary");
  const all = state.units.items;
  const isSuper = state.user.role === "super_admin";
  const usersByUnit = new Map();
  for (const user of state.units.users) {
    const key = Number(user.region_id);
    if (!usersByUnit.has(key)) usersByUnit.set(key, []);
    usersByUnit.get(key).push(user);
  }
  const usersOf = (unit) => usersByUnit.get(unit.id) ?? [];
  const root = all.find((unit) => unit.type === "country");
  const provinces = all
    .filter((unit) => unit.type === "province")
    .sort((a, b) => faCollator.compare(a.name, b.name));
  const allCities = all.filter((unit) => unit.type === "city");
  const provinceIds = new Set(provinces.map((province) => province.id));
  const byName = (a, b) => faCollator.compare(a.name, b.name);
  const citiesOf = (provinceId) =>
    allCities.filter((city) => city.parent_id === provinceId).sort(byName);
  // A centre admin sees only their own centre, so its province is not in the list.
  const looseCities = allCities
    .filter((city) => !provinceIds.has(city.parent_id))
    .sort(byName);

  const stats = [];
  if (provinces.length > 1)
    stats.push([
      provinces.filter((province) => unitState(province).active).length,
      `از ${faDigits.format(provinces.length)} استان فعال`,
    ]);
  if (allCities.length > 1)
    stats.push([
      allCities.filter((city) => unitState(city).active).length,
      `از ${faDigits.format(allCities.length)} مرکز دانشگاهی فعال`,
    ]);
  stats.push([state.units.users.length, "کاربر"]);
  summary.innerHTML = stats
    .map(
      ([value, label]) =>
        `<div class="units-stat"><strong>${faDigits.format(value)}</strong><span>${label}</span></div>`,
    )
    .join("");

  // Accordion: at most one province stays open; the one being edited always wins.
  const editingUnit = all.find((unit) => unit.id === state.units.editing);
  if (editingUnit)
    state.units.open = new Set([
      editingUnit.type === "province" ? editingUnit.id : editingUnit.parent_id,
    ]);
  else if (state.units.open.size > 1)
    state.units.open = new Set([[...state.units.open].at(-1)]);

  const query = faKey(document.getElementById("structure-search").value);
  const filter =
    document.querySelector('input[name="structure_filter"]:checked')?.value ||
    "all";
  const wantActive = (active) =>
    filter === "all" || (filter === "active") === active;
  const nameMatches = (unit) => !query || faKey(unit.name).includes(query);
  const userMatches = (unit) =>
    Boolean(query) &&
    usersOf(unit).some((user) =>
      faKey(`${user.full_name} ${user.username}`).includes(query),
    );
  const cityShown = (city, parentMatches) =>
    (parentMatches || nameMatches(city) || userMatches(city)) &&
    wantActive(unitState(city).active);

  const html = [];
  if (root && filter === "all" && (nameMatches(root) || userMatches(root)))
    html.push(
      `<div class="unit-flat"><div class="unit-row unit-city"><div class="unit-main"><span class="unit-name">${escapeHtml(root.name)}</span></div><div class="unit-actions">${addUserButton(root)}</div>${usersBlock(usersOf(root), root)}</div></div>`,
    );
  for (const province of provinces) {
    const cities = citiesOf(province.id);
    const info = unitState(province);
    const nameMatch = nameMatches(province);
    const shownCities = cities.filter((city) => cityShown(city, nameMatch));
    const showProvince =
      (nameMatch || userMatches(province) || shownCities.length) &&
      (filter === "all" || wantActive(info.active) || shownCities.length);
    if (!showProvince) continue;
    const open =
      state.units.open.has(province.id) || Boolean(query) || filter !== "all";
    const editing = state.units.editing === province.id;
    const heading = editing
      ? `<div class="unit-province-edit">${unitEditForm(province)}</div>`
      : `<summary><span class="unit-name">${escapeHtml(province.name)}</span><span class="unit-meta">${faDigits.format(province.active_cities)} از ${faDigits.format(province.cities_total)} مرکز دانشگاهی فعال</span>${unitBadge(info)}${isSuper ? `<button class="mini-button" type="button" data-unit-edit="${province.id}">ویرایش</button>` : ""}</summary>`;
    const ownUsers = usersOf(province);
    const add = addUserButton(province);
    const own =
      ownUsers.length || add
        ? `<div class="unit-own"><span>کاربران خود استان</span>${add}</div>${usersBlock(ownUsers, province)}`
        : "";
    const rows =
      shownCities.map((city) => cityRow(city, usersOf(city))).join("") ||
      (allCities.length
        ? '<p class="empty-panel">مرکز دانشگاهی برای نمایش نیست.</p>'
        : "");
    html.push(
      `<details class="unit-province" data-province="${province.id}" ${open ? "open" : ""}>${editing ? `<summary class="is-editing">${escapeHtml(province.name)}</summary>${heading}` : heading}<div class="unit-body">${own}<div class="unit-cities">${rows}</div></div></details>`,
    );
  }
  const shownLoose = looseCities.filter((city) => cityShown(city, false));
  if (shownLoose.length)
    html.push(
      `<div class="unit-flat">${shownLoose.map((city) => cityRow(city, usersOf(city))).join("")}</div>`,
    );
  container.innerHTML =
    html.join("") || '<p class="empty-panel">موردی پیدا نشد.</p>';
}

async function loadStructure() {
  const container = document.getElementById("structure-tree");
  if (!state.units.items.length)
    container.innerHTML = '<p class="empty-panel">در حال دریافت فهرست…</p>';
  try {
    const [overview, users, targets] = await Promise.all([
      api("/api/admin/regions/overview"),
      api("/api/admin/users"),
      api("/api/admin/regions"),
    ]);
    state.units.items = overview.units;
    state.units.users = users.users;
    state.regions = targets.regions;
    // A province admin has exactly one province: show it open the first time.
    if (!state.units.seeded) {
      state.units.seeded = true;
      const provinces = overview.units.filter((unit) => unit.type === "province");
      if (provinces.length === 1)
        state.units.open = new Set([provinces[0].id]);
    }
    renderStructure();
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
    if (!isProvince) state.units.open = new Set([parentId]);
    form.hidden = true;
    form.reset();
    showToast(isProvince ? "استان افزوده شد." : "مرکز دانشگاهی افزوده شد.");
    await loadStructure();
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
    renderStructure();
    return;
  }
  try {
    await api(`/api/admin/regions/${id}`, { method: "PATCH", body });
    showToast("تغییرات ذخیره شد.");
  } catch (error) {
    showToast(error.message);
  }
  await loadStructure();
  setScopeBanner();
}

async function deleteUnit(id) {
  const unit = state.units.items.find((item) => item.id === id);
  if (!unit) return;
  const users = faDigits.format(unit.users_total || 0);
  const news = faDigits.format(unit.news_total || 0);
  const first = await confirmDialog({
    title: `حذف مرکز «${unit.name}»؟`,
    text: `این مرکز با همهٔ کاربرانش (${users} کاربر) و همهٔ خبرهایی که منتشر کرده (${news} خبر، همراه تصویر و پیوست‌ها) برای همیشه پاک می‌شود.`,
    tone: "danger",
    confirmText: "ادامه",
  });
  if (!first) return;
  const second = await confirmDialog({
    title: "تأیید نهایی حذف",
    text: `آخرین بار می‌پرسیم: مرکز «${unit.name}» کاملاً حذف شود؟ این کار قابل بازگشت نیست.`,
    tone: "danger",
    confirmText: "بله، برای همیشه حذف شود",
  });
  if (!second) return;
  try {
    const result = await api(`/api/admin/regions/${id}`, {
      method: "DELETE",
      body: {},
    });
    if (state.units.editing === id) state.units.editing = null;
    showToast(
      `مرکز «${unit.name}» حذف شد (${faDigits.format(result.users_deleted)} کاربر و ${faDigits.format(result.news_deleted)} خبر).`,
    );
    await loadStructure();
    setScopeBanner();
  } catch (error) {
    showToast(error.message);
  }
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

// ---------- Work domains (main admin only) ----------
function domainRow(domain) {
  if (state.domainAdmin.editing === domain.id) {
    return `<div class="category-row is-editing"><form class="category-edit" data-domain-form="${domain.id}"><label>نام حوزه<input name="name" maxlength="120" required autocomplete="off" value="${escapeHtml(domain.name)}"></label><button class="button primary" type="submit">ذخیره</button><button class="button outline" type="button" data-domain-cancel>انصراف</button></form></div>`;
  }
  const count = domain.users_count
    ? `${faDigits.format(domain.users_count)} کاربر`
    : "بدون کاربر";
  return (
    `<div class="category-row${domain.is_active ? "" : " is-inactive"}" data-domain-id="${domain.id}">` +
    `<div class="category-main"><span class="category-name">${escapeHtml(domain.name)}</span><small>${count}</small></div>` +
    `<span class="status-badge ${domain.is_active ? "published" : "draft"}">${domain.is_active ? "فعال" : "غیرفعال"}</span>` +
    `<div class="category-actions">` +
    `<button class="mini-button" type="button" data-domain-edit="${domain.id}">ویرایش</button>` +
    `<button class="mini-button" type="button" data-domain-toggle="${domain.id}">${domain.is_active ? "غیرفعال‌سازی" : "فعال‌سازی"}</button>` +
    `<button class="mini-button danger" type="button" data-domain-delete="${domain.id}">حذف</button>` +
    `</div></div>`
  );
}

function renderDomains() {
  const panel = document.getElementById("domains-list");
  const items = state.domainAdmin.items;
  panel.innerHTML = items.length
    ? items.map(domainRow).join("")
    : '<p class="empty-panel">هنوز حوزه‌ای ثبت نشده است. با «حوزهٔ تازه» نخستین مورد را بسازید.</p>';
}

async function loadDomains() {
  const panel = document.getElementById("domains-list");
  if (!state.domainAdmin.items.length)
    panel.innerHTML = '<p class="empty-panel">در حال دریافت فهرست…</p>';
  try {
    const { domains } = await api("/api/admin/domains?manage=1");
    state.domainAdmin.items = domains;
    renderDomains();
  } catch (error) {
    panel.innerHTML = `<p class="empty-panel">${escapeHtml(error.message)}</p>`;
  }
}

async function submitDomain(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.getElementById("domain-error");
  message.textContent = "";
  try {
    await api("/api/admin/domains", {
      method: "POST",
      body: { name: form.elements.name.value },
    });
    form.hidden = true;
    form.reset();
    showToast("حوزه افزوده شد.");
    await loadDomains();
  } catch (error) {
    message.textContent = error.message;
  }
}

async function saveDomainName(form) {
  const id = Number(form.dataset.domainForm);
  const current = state.domainAdmin.items.find((item) => item.id === id);
  const name = form.elements.name.value.trim();
  if (!current || name === current.name) {
    state.domainAdmin.editing = null;
    renderDomains();
    return;
  }
  try {
    await api(`/api/admin/domains/${id}`, { method: "PATCH", body: { name } });
    state.domainAdmin.editing = null;
    showToast("نام حوزه ذخیره شد.");
    await loadDomains();
  } catch (error) {
    showToast(error.message);
  }
}

async function toggleDomain(id) {
  const current = state.domainAdmin.items.find((item) => item.id === id);
  if (!current) return;
  try {
    await api(`/api/admin/domains/${id}`, {
      method: "PATCH",
      body: { is_active: !current.is_active },
    });
    showToast(current.is_active ? "حوزه غیرفعال شد." : "حوزه فعال شد.");
    await loadDomains();
  } catch (error) {
    showToast(error.message);
  }
}

async function deleteDomain(id) {
  const current = state.domainAdmin.items.find((item) => item.id === id);
  if (!current) return;
  if (current.users_count > 0) {
    showMessage(
      "حذف ممکن نیست",
      `«${current.name}» ${faDigits.format(current.users_count)} کاربر دارد. در صورت نیاز آن را غیرفعال کنید تا برای کاربر تازه انتخاب نشود.`,
    );
    return;
  }
  if (
    !(await confirmDialog({
      title: `حذف «${current.name}»؟`,
      text: "این حوزه کاربری ندارد و برای همیشه حذف می‌شود.",
      tone: "danger",
      confirmText: "بله، حذف شود",
    }))
  )
    return;
  try {
    await api(`/api/admin/domains/${id}`, { method: "DELETE", body: {} });
    showToast("حوزه حذف شد.");
    await loadDomains();
  } catch (error) {
    showToast(error.message);
  }
}

function bindDomainEvents() {
  document.getElementById("new-domain-button").addEventListener("click", () => {
    const form = document.getElementById("domain-form");
    form.hidden = false;
    form.reset();
    document.getElementById("domain-error").textContent = "";
    form.elements.name.focus();
  });
  document
    .getElementById("domain-form")
    .addEventListener("submit", submitDomain);
  const list = document.getElementById("domains-list");
  list.addEventListener("click", (event) => {
    const edit = event.target.closest("[data-domain-edit]");
    if (edit) {
      state.domainAdmin.editing = Number(edit.dataset.domainEdit);
      renderDomains();
      list.querySelector(".category-edit input")?.focus();
      return;
    }
    if (event.target.closest("[data-domain-cancel]")) {
      state.domainAdmin.editing = null;
      renderDomains();
      return;
    }
    const toggle = event.target.closest("[data-domain-toggle]");
    if (toggle) {
      toggleDomain(Number(toggle.dataset.domainToggle));
      return;
    }
    const remove = event.target.closest("[data-domain-delete]");
    if (remove) deleteDomain(Number(remove.dataset.domainDelete));
  });
  list.addEventListener("submit", (event) => {
    const form = event.target.closest("[data-domain-form]");
    if (!form) return;
    event.preventDefault();
    saveDomainName(form);
  });
}

// ---------- Automatic portal news ----------
function describePortalRun(run) {
  if (!run) return "هنوز اجرایی ثبت نشده است.";
  const when = formatDate(run.at);
  if (run.error) return `آخرین اجرا (${when}) ناموفق بود: ${run.error}`;
  return `آخرین اجرا: ${when} · ${describePortalCreated(run.created)}`;
}

function describePortalCreated(created) {
  return created > 0
    ? `${faDigits.format(created)} خبر جدید دریافت شد`
    : "خبر جدیدی دریافت نشد";
}

async function loadPortalStatus() {
  try {
    const status = await api("/api/admin/portal-news");
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
    showToast(
      status.result?.error
        ? "دریافت ناموفق بود."
        : `${describePortalCreated(status.result?.created ?? 0)}.`,
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
    ]) {
      form.elements[key].value = settings[key] ?? "";
    }
    form.elements.radio_enabled.checked = settings.radio_enabled === "1";
    form.elements.byline_show_person.checked =
      settings.byline_show_person === "1";
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

// ---------- Reader accounts (the main admin only) ----------
// Reader signup on or off, the SMS credit and its limits, and the list of readers. The server (/api/admin/readers/*) decides
// everything; this only shows it. Nothing here can change or delete a reader's account.

const READER_SMS_ERRORS = {
  timeout: "پاسخی نرسید",
  network: "اتصال برقرار نشد",
  invalid_response: "پاسخ قابل فهم نبود",
  rejected: "ippanel نپذیرفت",
  not_configured: "ippanel تنظیم نشده",
};

function readerSmsError(error) {
  const label = READER_SMS_ERRORS[error?.kind] || "خطای نامشخص";
  return error?.message_code || error?.code ? `${label}، کد ${error.message_code || error.code}` : label;
}

// +989121234567 -> 0912 123 4567
function readerPhone(phone) {
  const national = String(phone ?? "").replace(/^\+98/, "0");
  return toFaDigits(/^\d{11}$/.test(national)
    ? `${national.slice(0, 4)} ${national.slice(4, 7)} ${national.slice(7)}`
    : national);
}

function renderReadersBanner(settings, status) {
  const banner = document.getElementById("readers-banner");
  const info = status.signup_disabled;
  let level = "";
  let text = "";
  if (!settings.signup_enabled && info) {
    level = "danger";
    const when = formatDate(info.at);
    if (info.reason === "low_credit") {
      text = `ثبت‌نام خودش خاموش شد (${when}): اعتبار پیامک رو به پایان بود و فقط حدود ${faDigits.format(info.remaining ?? 0)} پیامک باقی مانده بود. اعتبار را شارژ کنید و ثبت‌نام را دوباره روشن کنید.`;
    } else if (info.reason === "send_failures") {
      text = `ثبت‌نام خودش خاموش شد (${when}): ${faDigits.format(info.failures ?? 5)} ارسال پیامک در ۱۰ دقیقه ناموفق بود (آخرین نشانهٔ خطا: ${info.last ?? "نامشخص"}). اتصال به ippanel، کلید و اعتبار را بررسی کنید و ثبت‌نام را دوباره روشن کنید.`;
    } else text = `ثبت‌نام خودش خاموش شد (${when}).`;
  } else if (settings.signup_enabled && !status.configured) {
    level = "warning";
    text =
      "ثبت‌نام روشن است، اما ippanel تنظیم نشده (IPPANEL_API_KEY، IPPANEL_PATTERN_CODE و IPPANEL_FROM_NUMBER در .autostart)؛ خوانندگان نمی‌توانند کد بگیرند.";
  } else if (status.dry_run) {
    level = "info";
    text =
      "حالت آزمایشی (IPPANEL_DRY_RUN) روشن است: پیامکی فرستاده نمی‌شود و کد در کنسول سرور چاپ می‌شود.";
  }
  banner.hidden = !text;
  banner.dataset.level = level;
  banner.textContent = text; // text only: the reason comes from the server's notice
}

function renderReadersCredit(status) {
  const target = document.getElementById("readers-credit");
  if (!status.configured) {
    target.innerHTML =
      '<p class="empty-panel">ippanel هنوز تنظیم نشده است؛ اعتبار خوانده نمی‌شود.</p>';
    return;
  }
  const parts = [];
  if (status.credit_rial !== null) {
    const rial = Math.floor(status.credit_rial);
    const level =
      status.remaining < status.min_remaining
        ? "danger"
        : status.remaining < status.min_remaining * 2
          ? "warning"
          : "ok";
    parts.push(
      `<strong class="credit-number">${faDigits.format(rial)} <small>ریال</small></strong><span class="credit-sub">${faDigits.format(Math.floor(rial / 10))} تومان</span>`,
      `<p class="credit-estimate" data-level="${level}">حدود <b>${faDigits.format(status.remaining)}</b> پیامک باقی است <small>(با هزینهٔ ${faDigits.format(status.cost_rial)} ریال برای هر پیامک؛ زیر ${faDigits.format(status.min_remaining)} پیامک، ثبت‌نام خودکار خاموش می‌شود)</small></p>`,
      `<p class="card-hint">آخرین خواندن اعتبار: ${formatDate(status.credit_checked_at)}</p>`,
    );
  } else {
    parts.push('<p class="empty-panel">اعتبار هنوز خوانده نشده است.</p>');
  }
  if (status.credit_error) {
    parts.push(
      `<p class="portal-status is-error">خواندن اعتبار از ippanel ناموفق بود (${escapeHtml(readerSmsError(status.credit_error))})${status.credit_rial !== null ? "؛ آخرین مقدار شناخته‌شده نمایش داده شده است" : ""}.</p>`,
    );
  }
  parts.push(
    `<p class="credit-day">در ۲۴ ساعت گذشته ${faDigits.format(status.sent_24h)} پیامک از سقف ${faDigits.format(status.daily_cap)} ارسال شده است.</p>`,
  );
  target.innerHTML = parts.join("");
}

function renderReadersFailures(status) {
  const target = document.getElementById("readers-failures");
  target.innerHTML = status.recent_failures.length
    ? `<ul class="readers-failures">${status.recent_failures
        .map(
          (item) =>
            `<li><span dir="ltr">${escapeHtml(readerPhone(item.phone))}</span><span>${escapeHtml(toFaDigits(item.code) || "—")}</span><time>${formatDate(item.at)}</time></li>`,
        )
        .join("")}</ul>`
    : '<p class="empty-panel">ارسال ناموفقی ثبت نشده است.</p>';
}

// Why the webhook ignored an SMS (reader_inbound_log.reason), as the main admin reads it.
const READER_INBOUND_REASONS = {
  confirmed: "پیامک تأیید شد",
  bad_key: "کلید نادرست یا نبودن کلید در نشانی",
  wrong_method: "روش «ارسال پیامک از طرف خواننده» فعال نیست",
  ip_blocked: "نشانی IP فرستنده مجاز نیست",
  bad_sender: "فرستنده شمارهٔ موبایل نبود",
  wrong_line: "گیرنده همان خط دریافت تنظیم‌شده نبود",
  no_code: "در متن پیام کد ۶ رقمی نبود",
  no_match: "کد با هیچ درخواست بازِ این شماره نخورد (منقضی، تکراری یا شمارهٔ دیگر)",
};

function renderReadersInbound(data) {
  const field = document.getElementById("readers-webhook-url");
  document.getElementById("readers-webhook").hidden = !data.webhook_url;
  field.value = data.webhook_url ?? "";
  const target = document.getElementById("readers-inbound-log");
  target.innerHTML = data.recent.length
    ? `<ul class="readers-inbound-log">${data.recent
        .map(
          (item) =>
            `<li class="${item.outcome === "confirmed" ? "is-confirmed" : ""}"><span dir="ltr">${escapeHtml(toFaDigits(item.phone || "—"))}</span><span>${escapeHtml(READER_INBOUND_REASONS[item.reason] || "دلیل نامشخص")}</span><time>${formatDate(item.at)}</time></li>`,
        )
        .join("")}</ul>`
    : '<p class="empty-panel">هنوز پیامکی دریافت نشده است.</p>';
}

async function loadReaderInbound() {
  renderReadersInbound(await api("/api/admin/readers/inbound"));
}

function paintReaderMethod(settings) {
  const form = document.getElementById("readers-method-form");
  for (const radio of form.elements.auth_method) radio.checked = radio.value === settings.auth_method;
  if (!form.contains(document.activeElement)) {
    form.elements.inbound_line.value = settings.inbound_line;
    form.elements.inbound_ips.value = settings.inbound_ips.join("\n");
  }
  document.getElementById("readers-inbound-fields").hidden = settings.auth_method !== "sms_receive";
}

async function loadReaderStatus({ refresh = false } = {}) {
  const [{ settings }, { status }] = await Promise.all([
    api("/api/admin/readers/settings"),
    api(`/api/admin/readers/sms-status${refresh ? "?refresh=1" : ""}`),
  ]);
  state.readerStatus = status;
  state.readerSettings = settings;
  paintReaderMethod(settings);
  document.getElementById("readers-signup-switch").checked = settings.signup_enabled;
  document.getElementById("readers-signup-state").textContent = settings.signup_enabled
    ? "روشن است."
    : status.signup_disabled
      ? "خاموش است (به‌طور خودکار؛ دلیلش بالای صفحه نوشته شده)."
      : "خاموش است.";
  const form = document.getElementById("readers-limits-form");
  if (!form.contains(document.activeElement)) {
    for (const name of ["sms_cost_rial", "sms_min_remaining", "sms_daily_cap"]) {
      form.elements[name].value = String(settings[name]);
    }
  }
  renderReadersBanner(settings, status);
  renderReadersCredit(status);
  renderReadersFailures(status);
}

async function loadReaderUsers(page = state.readersPage ?? 1) {
  state.readersPage = page;
  const ticket = (state.readersTicket = (state.readersTicket ?? 0) + 1);
  const list = document.getElementById("readers-list");
  const query = document.getElementById("readers-search").value.trim();
  const params = new URLSearchParams({ page: String(page), limit: "25" });
  if (query) params.set("q", query);
  try {
    const data = await api(`/api/admin/readers/users?${params}`);
    if (ticket !== state.readersTicket) return; // a newer search has taken over
    state.readersPage = data.page;
    state.readerItems = new Map(data.items.map((item) => [Number(item.id), item]));
    document.getElementById("readers-totals").textContent =
      `${faDigits.format(data.totals.readers)} خواننده، ${faDigits.format(data.totals.students)} دانشجو${query ? ` · ${faDigits.format(data.total)} نتیجه` : ""}`;
    list.innerHTML = data.items.length
      ? `<table class="table readers-table"><thead><tr><th>نام</th><th>شمارهٔ موبایل</th><th>مرکز</th><th>شمارهٔ دانشجویی <small>(اعلام‌شدهٔ کاربر)</small></th><th>ثبت‌نام</th><th>عملیات</th></tr></thead><tbody>${data.items
          .map(
            (item) =>
              `<tr><td><strong>${escapeHtml(`${item.first_name} ${item.last_name}`)}</strong></td><td dir="ltr">${escapeHtml(readerPhone(item.phone))}</td><td>${item.unit ? `${escapeHtml(item.unit.name)}${item.unit.province ? `<small>${escapeHtml(item.unit.province)}</small>` : ""}` : "—"}</td><td dir="ltr">${item.student_no ? escapeHtml(toFaDigits(item.student_no)) : "—"}</td><td>${formatDate(item.created_at)}</td><td class="readers-actions"><div class="compact-actions"><button class="mini-button" type="button" data-reader-action="edit" data-reader-id="${Number(item.id)}">ویرایش</button><button class="mini-button danger" type="button" data-reader-action="delete" data-reader-id="${Number(item.id)}">حذف</button></div></td></tr>`,
          )
          .join("")}</tbody></table>`
      : `<p class="empty-panel">${query ? `نتیجه‌ای برای «${escapeHtml(query)}» پیدا نشد.` : "هنوز کسی ثبت‌نام نکرده است."}</p>`;
    renderPager(document.getElementById("readers-pager"), data);
  } catch (error) {
    if (ticket === state.readersTicket) list.innerHTML = `<p class="empty-panel">${escapeHtml(error.message)}</p>`;
  }
}

// Edit or delete one reader account (main admin only; the server enforces it). The phone number is shown but never changes.
function editReaderDialog(item) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "swal-dialog reader-edit-dialog";
    dialog.setAttribute("aria-labelledby", "reader-edit-title");
    const cities = state.regions.filter((region) => region.type === "city");
    const provinceName = (region) =>
      state.regions.find((other) => Number(other.id) === Number(region.parent_id))?.name ?? "";
    const unitId = item.unit ? Number(item.unit.id) : 0;
    const options = cities
      .map((city) => {
        const province = provinceName(city);
        const label = province ? `${city.name} (${province})` : city.name;
        return `<option value="${Number(city.id)}"${Number(city.id) === unitId ? " selected" : ""}>${escapeHtml(label)}</option>`;
      })
      .join("");
    dialog.innerHTML =
      `<form class="swal-panel reader-edit-form" novalidate><h2 id="reader-edit-title" class="swal-title">ویرایش خواننده</h2>` +
      `<p class="swal-text" dir="ltr">${escapeHtml(readerPhone(item.phone))}</p>` +
      `<label class="reader-edit-field">نام<input class="swal-input" name="first_name" maxlength="60" autocomplete="off" value="${escapeHtml(item.first_name)}"></label>` +
      `<label class="reader-edit-field">نام خانوادگی<input class="swal-input" name="last_name" maxlength="60" autocomplete="off" value="${escapeHtml(item.last_name)}"></label>` +
      `<label class="reader-edit-check"><input type="checkbox" name="is_student"${item.is_student ? " checked" : ""}> دانشجو است</label>` +
      `<label class="reader-edit-field" data-student-field>شمارهٔ دانشجویی<input class="swal-input" name="student_no" dir="ltr" inputmode="numeric" maxlength="20" autocomplete="off" value="${escapeHtml(item.student_no ?? "")}"></label>` +
      `<label class="reader-edit-field">مرکز دانشگاهی<select class="swal-input" name="unit_id">${options}</select></label>` +
      `<p class="form-error" role="alert" hidden></p>` +
      `<div class="swal-actions"><button type="submit" class="button primary">ذخیره</button><button type="button" class="button outline" data-swal="cancel">انصراف</button></div></form>`;
    const form = dialog.querySelector("form");
    const studentField = dialog.querySelector("[data-student-field]");
    const problem = dialog.querySelector(".form-error");
    const syncStudent = () => {
      studentField.hidden = !form.elements.is_student.checked;
    };
    syncStudent();
    form.elements.is_student.addEventListener("change", syncStudent);
    let result = null;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const values = {
        first_name: form.elements.first_name.value.trim(),
        last_name: form.elements.last_name.value.trim(),
        is_student: form.elements.is_student.checked,
        unit_id: Number(form.elements.unit_id.value),
      };
      if (values.is_student) values.student_no = form.elements.student_no.value.trim();
      if (!values.first_name || !values.last_name) {
        problem.textContent = "نام و نام خانوادگی را وارد کنید.";
        problem.hidden = false;
        return;
      }
      result = values;
      dialog.close();
    });
    dialog.addEventListener("click", (event) => {
      if (event.target.closest('[data-swal="cancel"]') || event.target === dialog) dialog.close();
    });
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(result);
    });
    document.body.append(dialog);
    dialog.showModal();
    form.elements.first_name.focus();
  });
}

async function handleReaderAction(button) {
  const id = Number(button.dataset.readerId);
  const item = state.readerItems?.get(id);
  if (!id || !item) return;
  const fullName = `${item.first_name} ${item.last_name}`;
  try {
    if (button.dataset.readerAction === "edit") {
      const values = await editReaderDialog(item);
      if (!values) return;
      await api(`/api/admin/readers/users/${id}`, { method: "PATCH", body: values });
      showToast("اطلاعات خواننده ذخیره شد.");
    } else {
      const confirmed = await confirmDialog({
        title: `حذف «${fullName}»؟`,
        text: "حساب این خواننده با نشانک‌ها و ورودهای فعلی‌اش برای همیشه حذف می‌شود و قابل بازگشت نیست. او می‌تواند دوباره با همان شماره ثبت‌نام کند.",
        tone: "danger",
        confirmText: "بله، حذف شود",
      });
      if (!confirmed) return;
      await api(`/api/admin/readers/users/${id}`, { method: "DELETE", body: {} });
      showToast("خواننده حذف شد.");
    }
    await loadReaderUsers();
  } catch (error) {
    showToast(error.message);
  }
}

async function loadReaders() {
  try {
    await loadReaderStatus();
  } catch (error) {
    showToast(error.message);
  }
  try {
    await loadReaderInbound();
  } catch (error) {
    showToast(error.message);
  }
  await loadReaderUsers(1);
}

function initReadersPanel() {
  const signup = document.getElementById("readers-signup-switch");
  signup.addEventListener("change", async () => {
    const wanted = signup.checked;
    if (wanted && state.readerStatus && !state.readerStatus.configured && state.readerSettings?.auth_method !== "sms_receive") {
      const sure = await confirmDialog({
        title: "ippanel تنظیم نشده است",
        text: "کلید و پترن پیامک در سرور نیست و خوانندگان نمی‌توانند کد بگیرند. با این حال روشن شود؟",
        tone: "warning",
        confirmText: "بله، روشن شود",
        cancelText: "انصراف",
      });
      if (!sure) {
        signup.checked = false;
        return;
      }
    }
    signup.disabled = true;
    try {
      await api("/api/admin/readers/settings", { method: "PUT", body: { signup_enabled: wanted } });
      showToast(wanted ? "ثبت‌نام خوانندگان روشن شد." : "ثبت‌نام خوانندگان خاموش شد.");
      await loadReaderStatus();
    } catch (error) {
      signup.checked = !wanted;
      showToast(error.message);
    } finally {
      signup.disabled = false;
    }
  });

  // The way a reader proves the number: we send a code (sms_send) or the reader sends an SMS to our line (sms_receive).
  const methodForm = document.getElementById("readers-method-form");
  const methodProblem = document.getElementById("readers-method-error");
  const chosenMethod = () => methodForm.elements.auth_method.value;
  methodForm.addEventListener("change", (event) => {
    if (event.target.name === "auth_method") document.getElementById("readers-inbound-fields").hidden = chosenMethod() !== "sms_receive";
  });
  methodForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    methodProblem.hidden = true;
    const method = chosenMethod();
    if (!method) {
      methodProblem.textContent = "یکی از دو روش را انتخاب کنید.";
      methodProblem.hidden = false;
      return;
    }
    const body = { auth_method: method };
    if (method === "sms_receive") {
      body.inbound_line = normalizeDigits(methodForm.elements.inbound_line.value).replace(/\s/g, "");
      body.inbound_ips = normalizeDigits(methodForm.elements.inbound_ips.value).split(/[\s,،]+/).filter(Boolean);
    }
    const button = methodForm.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      await api("/api/admin/readers/settings", { method: "PUT", body });
      showToast("روش ورود ذخیره شد.");
      await loadReaderStatus();
      await loadReaderInbound();
    } catch (error) {
      methodProblem.textContent = error.message;
      methodProblem.hidden = false;
    } finally {
      button.disabled = false;
    }
  });
  document.getElementById("readers-webhook-copy").addEventListener("click", async () => {
    const field = document.getElementById("readers-webhook-url");
    try {
      await navigator.clipboard.writeText(field.value);
      showToast("نشانی کپی شد.");
    } catch {
      field.select();
      showToast(document.execCommand("copy") ? "نشانی کپی شد." : "کپی نشد؛ نشانی انتخاب شده است، دستی کپی کنید.");
    }
  });
  document.getElementById("readers-key-rotate").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const sure = await confirmDialog({
      title: "ساخت کلید جدید",
      text: "نشانی فعلی بلافاصله از کار می‌افتد و تا وقتی نشانی تازه را در ippanel نگذارید، ورود با پیامک انجام نمی‌شود. ادامه می‌دهید؟",
      tone: "danger",
      confirmText: "بله، کلید جدید",
      cancelText: "انصراف",
    });
    if (!sure) return;
    button.disabled = true;
    try {
      await api("/api/admin/readers/inbound-key", { method: "POST", body: {} });
      showToast("کلید جدید ساخته شد؛ نشانی تازه را در ippanel بگذارید.");
      await loadReaderInbound();
    } catch (error) {
      showToast(error.message);
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById("readers-refresh").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await loadReaderStatus({ refresh: true });
    } catch (error) {
      showToast(error.message);
    } finally {
      button.disabled = false;
    }
  });

  const form = document.getElementById("readers-limits-form");
  const problem = document.getElementById("readers-limits-error");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    problem.hidden = true;
    const body = {};
    for (const name of ["sms_cost_rial", "sms_min_remaining", "sms_daily_cap"]) {
      const text = normalizeDigits(form.elements[name].value).replace(/[\s,٬]/g, "");
      if (!/^\d+$/.test(text)) {
        problem.textContent = "هر سه مقدار را فقط با رقم وارد کنید.";
        problem.hidden = false;
        return;
      }
      body[name] = Number(text);
    }
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      await api("/api/admin/readers/settings", { method: "PUT", body });
      showToast("هزینه و سقف‌ها ذخیره شد.");
      await loadReaderStatus();
    } catch (error) {
      problem.textContent = error.message;
      problem.hidden = false;
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById("readers-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-reader-action]");
    if (button) handleReaderAction(button);
  });

  let searchTimer = null;
  document.getElementById("readers-search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadReaderUsers(1), 300);
  });
}

function entityLabel(entity) {
  return (
    {
      news: "خبر",
      user: "کاربر",
      region: "مرکز یا واحد",
      settings: "تنظیمات",
      reader_settings: "حساب خوانندگان",
      reader_user: "خواننده",
      category: "دسته‌بندی",
    }[entity] || "سامانه"
  );
}

function auditAction(action) {
  const labels = {
    "auth.login": "ورود",
    "auth.logout": "خروج",
    "auth.login_failed": "ورود ناموفق",
    "user.bulk_create": "ساخت گروهی مدیران",
    "auth.totp_enabled": "روشن‌شدن رمز دومرحله‌ای",
    "auth.totp_disabled": "خاموش‌شدن رمز دومرحله‌ای",
    "auth.sessions_revoked": "خروج از همهٔ دستگاه‌ها",
    "news.create": "ساخت خبر",
    "news.update": "ویرایش خبر",
    "news.delete": "حذف خبر",
    "news.publish": "انتشار خبر",
    "news.schedule": "زمان‌بندی خبر",
    "news.unpublish": "لغو انتشار",
    "news.assign": "اختصاص خبر به کاربر دیگر",
    "user.create": "ساخت کاربر",
    "user.deactivate": "غیرفعال‌سازی کاربر",
    "user.activate": "فعال‌سازی کاربر",
    "user.delete": "حذف کاربر",
    "reader.user.update": "ویرایش خواننده",
    "reader.user.delete": "حذف خواننده",
    "settings.update": "تغییر تنظیمات",
    "reader.settings.update": "تغییر تنظیمات حساب خوانندگان",
    "reader.signup.auto_disabled": "خاموش‌شدن خودکار ثبت‌نام خوانندگان",
    "reader.auth_method.change": "تغییر روش ورود خوانندگان",
    "reader.inbound_key.rotate": "ساخت کلید جدید وب‌هوک پیامک",
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

// نسخهٔ دسکتاپ همیشه نشست ۲۴ ساعته دارد؛ «به یاد سپاری» فقط روی گوشی است (سرور هم همین را از User-Agent بررسی می‌کند).
const isMobileDevice = () =>
  /Android.+Mobile|iPhone|iPod|Windows Phone|IEMobile|Opera Mini|BlackBerry|\bMobile\b/i.test(
    navigator.userAgent,
  );

function resetTotpPanel() {
  document.getElementById("profile-totp-enroll").hidden = true;
  document.getElementById("profile-totp-disable-form").hidden = true;
  document.getElementById("profile-totp-backup").hidden = true;
  document.getElementById("profile-totp-enable-form")?.reset();
  document.getElementById("profile-totp-disable-form")?.reset();
}

function renderTotpPanel(enabled) {
  resetTotpPanel();
  document.getElementById("profile-totp-status").textContent = enabled
    ? "رمز دومرحله‌ای روشن است؛ در هر ورود، پس از گذرواژه کد برنامهٔ رمزساز هم پرسیده می‌شود."
    : "رمز دومرحله‌ای خاموش است؛ ورود فقط با گذرواژه انجام می‌شود. برای امنیت بیشتر می‌توانید آن را روشن کنید.";
  document.getElementById("profile-totp-start").hidden = enabled;
  document.getElementById("profile-totp-disable-open").hidden = !enabled;
}

async function loadProfile() {
  document.getElementById("profile-password-form")?.reset();
  document.getElementById("profile-password-error").textContent = "";
  try {
    const [me, sessionResponse] = await Promise.all([
      api("/api/auth/me"),
      api("/api/auth/sessions"),
    ]);
    state.user = me.user;
    renderTotpPanel(Boolean(me.user.totp_enabled));
    const profile = document.getElementById("profile-details");
    profile.innerHTML = `<dt>نام</dt><dd>${escapeHtml(me.user.full_name)}</dd><dt>نام کاربری</dt><dd>${escapeHtml(me.user.username)}</dd><dt>نقش</dt><dd>${escapeHtml(roleLabel(me.user.role, me.user.domain_name))}</dd><dt>محدوده</dt><dd>${escapeHtml(regionName(me.user.region_id))}</dd>`;
    document.getElementById("device-list").innerHTML = sessionResponse.sessions
      .length
      ? sessionResponse.sessions
          .map(
            (item) =>
              `<div class="compact-item"><div class="compact-item-main"><strong>${escapeHtml(item.user_agent || "دستگاه نامشخص")}${item.current ? " (همین دستگاه)" : ""}</strong><small>${formatDate(item.created_at)} · ${item.remember ? "به‌یادسپرده‌شده" : `پایان ${formatDate(item.expires_at)}`}</small></div></div>`,
          )
          .join("")
      : '<p class="muted">نشست فعالی ثبت نشده است.</p>';
  } catch (error) {
    showToast(error.message);
  }
}

async function startTotpEnrollment() {
  try {
    const setup = await api("/api/auth/totp/setup", { method: "POST", body: {} });
    const svg = new TextEncoder().encode(setup.qr_svg);
    let binary = "";
    for (const byte of svg) binary += String.fromCharCode(byte);
    document.getElementById("profile-totp-qr").src =
      `data:image/svg+xml;base64,${btoa(binary)}`;
    document.getElementById("profile-totp-secret").textContent = setup.secret;
    document.getElementById("profile-totp-start").hidden = true;
    document.getElementById("profile-totp-enroll").hidden = false;
    document.getElementById("profile-totp-enable-form").elements.code.focus();
  } catch (error) {
    showToast(error.message);
  }
}

async function submitTotpEnable(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const code = normalizeDigits(form.elements.code.value.trim());
    const result = await api("/api/auth/totp/enable", {
      method: "POST",
      body: { code },
    });
    renderTotpPanel(true);
    document.getElementById("profile-backup-codes").innerHTML = (
      result.backup_codes ?? []
    )
      .map((item) => `<li>${escapeHtml(item)}</li>`)
      .join("");
    document.getElementById("profile-totp-backup").hidden = false;
    document.getElementById("profile-totp-disable-open").hidden = true;
    showToast("رمز دومرحله‌ای روشن شد.");
  } catch (error) {
    showToast(error.message);
  }
}

async function submitTotpDisable(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api("/api/auth/totp/disable", {
      method: "POST",
      body: {
        password: form.elements.password.value,
        code: normalizeDigits(form.elements.code.value.trim()),
      },
    });
    renderTotpPanel(false);
    showToast("رمز دومرحله‌ای خاموش شد.");
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
        remember: isMobileDevice() && form.elements.remember.checked,
      },
    });
    if (result.next === "totp") {
      document.getElementById("totp-form").reset();
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
    const result = await api("/api/auth/totp", {
      method: "POST",
      body: { code },
    });
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
  if (
    !(await confirmDialog({
      title: "خروج از حساب؟",
      text: "از این دستگاه از پنل مدیریت خارج می‌شوید.",
      tone: "warning",
      confirmText: "بله، خارج شو",
      cancelText: "انصراف",
    }))
  )
    return;
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
  document.getElementById("login-remember-label").hidden = !isMobileDevice();
  document
    .getElementById("profile-totp-start")
    .addEventListener("click", startTotpEnrollment);
  document
    .getElementById("profile-totp-enable-form")
    .addEventListener("submit", submitTotpEnable);
  document
    .getElementById("profile-totp-cancel")
    .addEventListener("click", () => renderTotpPanel(false));
  document
    .getElementById("profile-totp-disable-open")
    .addEventListener("click", () => {
      document.getElementById("profile-totp-disable-open").hidden = true;
      document.getElementById("profile-totp-disable-form").hidden = false;
      document.getElementById("profile-totp-disable-form").elements.password.focus();
    });
  document
    .getElementById("profile-totp-disable-form")
    .addEventListener("submit", submitTotpDisable);
  document
    .getElementById("profile-totp-disable-cancel")
    .addEventListener("click", () => renderTotpPanel(true));
  document
    .getElementById("profile-backup-done")
    .addEventListener("click", () => renderTotpPanel(true));
  document.getElementById("logout-button").addEventListener("click", logout);
  document
    .getElementById("logout-everywhere")
    .addEventListener("click", async () => {
      if (
        !(await confirmDialog({
          title: "خروج از همهٔ دستگاه‌ها؟",
          text: "نشست همهٔ دستگاه‌ها (از جمله «به‌یادسپرده‌شده‌ها») لغو می‌شود و باید دوباره وارد شوید.",
          tone: "warning",
          confirmText: "بله، لغو شود",
        }))
      )
        return;
      try {
        await api("/api/auth/sessions", { method: "DELETE", body: {} });
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
  bindDomainEvents();
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
  initReadersPanel();
  const pagerHandlers = {
    "news-pager": (page) => loadNewsList(page),
    "audit-pager": (page) => loadAudit(page),
    "readers-pager": (page) => loadReaderUsers(page),
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
    .getElementById("editor-assign")
    .addEventListener("click", assignEditorNews);
  document
    .querySelector('#user-form [name="role"]')
    .addEventListener("change", syncUserFormRole);
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
      const flagButton = event.target.closest('[data-action="toggle-flag"]');
      if (flagButton) return toggleFlag(flagButton);
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
      if (event.target.closest('[data-action="cancel-domain"]'))
        document.getElementById("domain-form").hidden = true;
    });
  const structureTree = document.getElementById("structure-tree");
  structureTree.addEventListener("click", (event) => {
    const add = event.target.closest("[data-unit-add]");
    if (add) {
      event.preventDefault();
      openUserForm(Number(add.dataset.unitAdd));
      return;
    }
    const edit = event.target.closest("[data-unit-edit]");
    if (edit) {
      event.preventDefault();
      state.units.editing = Number(edit.dataset.unitEdit);
      renderStructure();
      document.querySelector('.unit-edit input[name="name"]')?.focus();
      return;
    }
    if (event.target.closest("[data-unit-cancel]")) {
      event.preventDefault();
      state.units.editing = null;
      renderStructure();
      return;
    }
    const remove = event.target.closest("[data-unit-delete]");
    if (remove) {
      event.preventDefault();
      deleteUnit(Number(remove.dataset.unitDelete));
    }
  });
  structureTree.addEventListener("submit", (event) => {
    const form = event.target.closest("[data-unit-form]");
    if (!form) return;
    event.preventDefault();
    saveUnit(form);
  });
  structureTree.addEventListener("click", (event) => {
    const summary = event.target.closest("summary");
    if (!summary || event.target.closest("button, input, select, textarea, a"))
      return;
    const province = summary.closest("[data-province]");
    if (!province) return;
    const id = Number(province.dataset.province);
    // the browser toggles `open` after this handler, so the new state is the opposite of the current one
    if (province.open) {
      state.units.open.delete(id);
      return;
    }
    // accordion: opening one province closes the one that was open
    for (const other of structureTree.querySelectorAll("details[data-province][open]"))
      if (other !== province) other.open = false;
    state.units.open = new Set([id]);
  });
  document
    .getElementById("structure-search")
    .addEventListener("input", renderStructure);
  document
    .getElementById("structure-filter")
    .addEventListener("change", renderStructure);

  document
    .getElementById("message-content")
    .addEventListener("click", async (event) => {
      const button = event.target.closest("[data-copy-secret]");
      if (!button) return;
      const secret =
        document.querySelector(".temp-secret code")?.textContent || "";
      try {
        await navigator.clipboard.writeText(secret);
        showToast("گذرواژه کپی شد.");
        button.innerHTML = CHECK_ICON;
        setTimeout(() => {
          button.innerHTML = COPY_ICON;
        }, 1500);
      } catch {
        showToast("کپی خودکار در دسترس نیست.");
      }
    });
}

bindEvents();
loadAdmin();
