// "Next astronomical / religious event" card, the first card of the important-news strip on the public reader.
//
// It appears on coarse-pointer devices after the visitor explicitly enables location from the card. This user action makes the
// browser's permission prompt visible instead of starting a delayed request in the background. The position never leaves the
// browser; it follows a traveller and is renewed every ten minutes. Prayer times use praytime.js (University of Tehran method,
// Jafari midnight), and the place name is the nearest city in iran-cities.v1.json.
import { PrayTime } from './praytime.v3.2.js';

export const EVENTS = [
  { key: 'fajr', label: 'اذان صبح' },
  { key: 'sunrise', label: 'طلوع آفتاب' },
  { key: 'dhuhr', label: 'اذان ظهر' },
  { key: 'asr', label: 'اذان عصر' },
  { key: 'sunset', label: 'غروب آفتاب' },
  { key: 'maghrib', label: 'اذان مغرب' },
  { key: 'isha', label: 'اذان عشا' },
  { key: 'midnight', label: 'نیمه‌شب شرعی' },
];

const DAY = 864e5;
const MAX_CITY_DISTANCE_KM = 150; // farther than this from any listed city the place is just "your location"
export const KEYS = {
  position: 'pnu.geo.pos', // { lat, lon, at }: last known position (about 1 km precision), kept in this browser only
  asked: 'pnu.geo.asked', // legacy key from the earlier automatic-prompt flow; no longer read or written
};
const CACHE_MAX_AGE = 7 * DAY; // a remembered position older than this is not used
// A traveller: one degree of longitude is about four minutes of prayer time (a city half an hour away is two or three minutes off),
// so with the permission granted the position is renewed when it is older than ten minutes, on opening the page, on coming back to
// it, and every few minutes while it stays open.
const REFRESH_AFTER = 10 * 60e3;
const RETRY_AFTER = 2 * 60e3; // a renewal that fails (no signal in a tunnel) is tried again after this
const SHOW_REMEMBERED_MAX = 30 * 60e3; // a remembered position older than this is not painted before a new one is known (the visitor may have moved)


// ---------- Pure calculations (no browser needed; covered by tests) ----------

// Events around `now` (yesterday, today, tomorrow at that longitude), oldest first. Yesterday is needed because the
// Jafari midnight of the previous evening can fall after 00:00 today.
export function computeEvents(now, lat, lon) {
  const events = [];
  for (const offset of [-1, 0, 1]) {
    const day = new Date(now + offset * DAY);
    const times = new PrayTime('Tehran').location([lat, lon]).format('x').times([day.getFullYear(), day.getMonth() + 1, day.getDate()]);
    for (const event of EVENTS) {
      const at = times[event.key];
      if (typeof at === 'number' && Number.isFinite(at)) events.push({ ...event, at });
    }
  }
  return events.sort((a, b) => a.at - b.at);
}

export const nextEvent = (now, lat, lon) => computeEvents(now, lat, lon).find((event) => event.at > now) ?? null;

const radians = (degrees) => (degrees * Math.PI) / 180;
export function distanceKm(lat1, lon1, lat2, lon2) {
  const a = Math.sin(radians(lat2 - lat1) / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(radians(lon2 - lon1) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

// cities: [[name, province, lat, lon], ...]. Returns the nearest one, or null when none is within the limit.
export function nearestCity(cities, lat, lon, limitKm = MAX_CITY_DISTANCE_KM) {
  let best = null;
  let bestKm = Infinity;
  for (const city of cities ?? []) {
    const km = distanceKm(lat, lon, city[2], city[3]);
    if (km < bestKm) { bestKm = km; best = city; }
  }
  return best && bestKm <= limitKm ? { name: best[0], province: best[1], km: bestKm } : null;
}

const faNumber = (value) => Number(value).toLocaleString('fa-IR', { useGrouping: false });

export function countdownText(ms) {
  const minutes = Math.max(0, Math.ceil(ms / 6e4));
  if (minutes <= 1) return 'کمتر از یک دقیقه دیگر';
  if (minutes < 60) return `${faNumber(minutes)} دقیقه دیگر`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${faNumber(hours)} ساعت و ${faNumber(rest)} دقیقه دیگر` : `${faNumber(hours)} ساعت دیگر`;
}

export function timeText(at, timeZone) {
  try {
    return new Intl.DateTimeFormat('fa-IR', { hour: '2-digit', minute: '2-digit', hour12: false, ...(timeZone ? { timeZone } : {}) }).format(at);
  } catch {
    return new Intl.DateTimeFormat('fa-IR', { hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
  }
}

// The calendar day of a moment in a time zone, as YYYY-MM-DD (used to tell "tomorrow's fajr" from today's).
export function dayInZone(ms, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', ...(timeZone ? { timeZone } : {}) }).format(ms);
  } catch {
    return dayKey(ms);
  }
}

export const dayKey = (now) => {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

const escapeText = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

// Inner HTML of the card for a view made by the controller: place / event and its time / time left.
export function prayerMarkup(view) {
  if (view.kind === 'location') {
    const message = view.status === 'denied'
      ? 'دسترسی موقعیت مکانی در مرورگر بسته است؛ آن را در تنظیمات مرورگر فعال کنید.'
      : view.status === 'error'
        ? 'موقعیت دریافت نشد؛ اتصال را بررسی کنید و دوباره تلاش کنید.'
        : 'برای نمایش اوقات شرعی، موقعیت مکانی را فعال کنید.';
    const button = view.status === 'requesting' ? 'در حال دریافت موقعیت…' : view.status === 'denied' ? 'بعد از تغییر تنظیمات، تلاش کنید' : 'فعال‌کردن موقعیت مکانی';
    return `<div class="prayer-place">اوقات شرعی</div><div class="prayer-location-message">${message}</div>`
      + `<button class="prayer-location-request" type="button"${view.status === 'requesting' ? ' disabled' : ''}>${button}</button>`;
  }
  const place = view.city ? escapeText(view.city) : 'موقعیت شما';
  return `<div class="prayer-place">${place}</div>`
    + `<div class="prayer-line"><strong class="prayer-name">${view.label}</strong><time class="prayer-time" datetime="${new Date(view.at).toISOString()}">${view.timeText}</time></div>`
    + `<div class="prayer-left">${view.countdown}</div>`;
}

// ---------- The controller: permission flow, remembered position, timer ----------

export function createPrayerCard({
  onChange = () => {},
  storage = globalThis.localStorage,
  geolocation = globalThis.navigator?.geolocation,
  permissions = globalThis.navigator?.permissions,
  now = () => Date.now(),
  loadCities = async () => (await (await fetch('/shared/iran-cities.v1.json')).json()).cities,
  timer = true,
} = {}) {
  let position = null; // { lat, lon, city? }: city is the name found last time, so the card is complete before the city list is loaded
  let positionAt = 0; // when the position was taken (the age of the remembered one is never extended by a city update)
  let shownRemembered = false;
  let cities = null;
  let citiesRequested = false;
  let current = null; // the event being counted down to
  let view = null;
  let interval = 0;
  let granted = false; // the permission is known to be granted: the position may be renewed without asking
  let locating = false;
  let active = false;
  let locationState = null; // prompt, denied, requesting, or error while there is no usable current position
  let lastAttempt = 0; // when the last position request was made (a failing one is not repeated every few seconds)

  const read = (key) => { try { return storage?.getItem(key) ?? null; } catch { return null; } };
  const write = (key, value) => { try { if (value == null) storage?.removeItem(key); else storage?.setItem(key, value); } catch { /* storage unavailable */ } };
  const remembered = () => {
    try {
      const saved = JSON.parse(read(KEYS.position));
      if (saved && Number.isFinite(saved.lat) && Number.isFinite(saved.lon) && now() - saved.at <= CACHE_MAX_AGE) return saved;
    } catch { /* corrupt entry */ }
    return null;
  };

  function recompute() {
    if (!position) { current = null; view = null; return; }
    const stamp = now();
    if (!current || current.at <= stamp) current = nextEvent(stamp, position.lat, position.lon);
    if (!current) { view = null; return; }
    const place = cities ? nearestCity(cities, position.lat, position.lon) : null;
    const city = cities ? (place?.name ?? null) : (position.city ?? null);
    if (cities && (position.city ?? null) !== city) { // remember the name for the next visit
      position.city = city ?? undefined;
      write(KEYS.position, JSON.stringify({ lat: position.lat, lon: position.lon, at: positionAt, ...(city ? { city } : {}) }));
    }
    const timeZone = city ? 'Asia/Tehran' : undefined; // a place inside Iran shows Iran's clock whatever the device says
    // After the midnight of the Jafari night the next event is the fajr of the next calendar day: say so ("اذان صبح فردا").
    // Only the fajr gets the word: the Jafari midnight itself may fall after 00:00 and is still "tonight".
    const nextDay = current.key === 'fajr' && dayInZone(current.at, timeZone) !== dayInZone(stamp, timeZone);
    view = {
      key: current.key, label: nextDay ? `${current.label} فردا` : current.label, at: current.at, city, province: place?.province ?? null,
      timeText: timeText(current.at, timeZone), countdown: countdownText(current.at - stamp),
    };
  }

  function publish() {
    if (locationState) view = { kind: 'location', status: locationState };
    else recompute();
    onChange(view);
    if (position && !cities && !citiesRequested) {
      citiesRequested = true;
      Promise.resolve().then(loadCities).then((list) => { cities = Array.isArray(list) ? list : null; publish(); }).catch(() => {}); // without the list the card still works, just without the city name
    }
  }

  function forget() {
    position = null;
    write(KEYS.position, null);
    publish();
  }

  const getPosition = () => new Promise((resolve) => {
    try {
      geolocation.getCurrentPosition(
        (result) => resolve({ ok: true, lat: result.coords.latitude, lon: result.coords.longitude }),
        (error) => resolve({ ok: false, code: error?.code }),
        { enableHighAccuracy: false, timeout: 12000, maximumAge: 60 * 1000 }, // never an answer older than a minute: a moving visitor needs the present place
      );
    } catch {
      resolve({ ok: false, code: 0 });
    }
  });

  // The last remembered position as a fallback, when a new one cannot be had.
  function useRemembered(maxAge) {
    if (position) return;
    const saved = remembered();
    if (!saved || now() - saved.at > maxAge) return;
    position = { lat: saved.lat, lon: saved.lon, ...(typeof saved.city === 'string' && saved.city ? { city: saved.city } : {}) };
    positionAt = saved.at;
    publish();
  }

  async function locate() {
    if (locating) return;
    locating = true;
    lastAttempt = now();
    try {
      await locateOnce();
    } finally {
      locating = false;
    }
  }

  async function locateOnce() {
    locationState = 'requesting';
    publish();
    const result = await getPosition();
    if (result.ok) {
      locationState = null;
      const lat = Math.round(result.lat * 100) / 100; // about 1 km is plenty for prayer times
      const lon = Math.round(result.lon * 100) / 100;
      const same = position && position.lat === lat && position.lon === lon;
      position = { lat, lon, ...(same && position.city ? { city: position.city } : {}) };
      positionAt = now();
      if (!same) current = null; // another place: the event and its time are worked out again for it (not kept from the old one)
      write(KEYS.position, JSON.stringify({ ...position, at: positionAt }));
      publish();
    } else if (result.code === 1) {
      locationState = 'denied';
      position = null;
      current = null;
      write(KEYS.position, null);
      publish();
    } else {
      locationState = 'error';
      position = null;
      current = null;
      publish();
    }
  }

  async function permissionState() {
    try {
      const status = await permissions.query({ name: 'geolocation' });
      return { state: status.state, status };
    } catch {
      return { state: 'unknown', status: null };
    }
  }

  let watched = null;
  async function check() {
    if (!active || !geolocation) return;
    const { state, status } = await permissionState();
    if (status && status !== watched) { // the visitor changes the permission in the browser: follow it at once
      watched = status;
      status.addEventListener?.('change', () => { check(); });
    }
    const saved = remembered();
    if (state === 'denied') {
      granted = false;
      locationState = 'denied';
      position = null;
      current = null;
      write(KEYS.position, null);
      publish();
      return;
    }
    granted = state === 'granted';
    if (granted) {
      locationState = null;
      if (saved && now() - saved.at <= REFRESH_AFTER) {
        position = { lat: saved.lat, lon: saved.lon, ...(typeof saved.city === 'string' && saved.city ? { city: saved.city } : {}) };
        positionAt = saved.at;
        publish();
      } else {
        position = null;
        current = null;
        await locate();
      }
      return;
    }
    // Do not reuse a location saved for another visitor/device session when permission is not currently granted.
    position = null;
    current = null;
    locationState = 'prompt';
    publish();
  }

  function tick() {
    if (!active) return;
    // While the page stays open (in a moving car, say) a granted permission keeps the place current.
    if (granted && !locating && !globalThis.document?.hidden && now() - lastAttempt >= RETRY_AFTER
      && ((position && now() - positionAt > REFRESH_AFTER) || (!position && locationState === 'error'))) locate();
    if (!position) return;
    const before = view ? `${view.key}|${view.countdown}|${view.at}` : '';
    recompute();
    if ((view ? `${view.key}|${view.countdown}|${view.at}` : '') !== before) onChange(view);
  }

  return {
    // Shows the remembered position at once and synchronously (nothing is awaited), so the page can paint it together
    // with the rest of the first screen. Returns whether there was one. Safe to call more than once.
    showRemembered() {
      if (shownRemembered) return Boolean(position);
      shownRemembered = true;
      const saved = remembered();
      if (saved && now() - saved.at <= SHOW_REMEMBERED_MAX) { // an older one might be another city by now: wait for a new position
        position = { lat: saved.lat, lon: saved.lon, ...(typeof saved.city === 'string' && saved.city ? { city: saved.city } : {}) };
        positionAt = saved.at;
        publish();
      }
      return Boolean(position);
    },
    // Then runs the permission flow (this may ask the visitor).
    async start() {
      active = true;
      if (timer && !interval) {
        interval = setInterval(tick, 20_000);
        document.addEventListener('visibilitychange', () => { if (active && !document.hidden) { tick(); check(); } });
      }
      await check();
    },
    async requestLocation() {
      if (!active || locating || !geolocation) return;
      if (locationState === 'denied') {
        const { state } = await permissionState();
        if (state === 'denied') return;
      }
      await locate();
    },
    stop() {
      active = false;
      if (interval) clearInterval(interval);
      interval = 0;
    },
    view: () => view,
    tick,
  };
}
