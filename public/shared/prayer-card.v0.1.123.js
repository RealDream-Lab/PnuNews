// "Next astronomical / religious event" card, the first card of the important-news strip on the public reader.
//
// It appears only when the visitor allows the browser to share the position. The position never leaves the browser:
// the times are computed here with praytime.js (University of Tehran method, Jafari midnight) and the place name is
// the nearest city of the bundled list (iran-cities.v1.json). When the visitor refuses (or ignores the question),
// the browser is asked again the next calendar day, not on every visit.
import { PrayTime } from './praytime.v3.2.js';

export const EVENTS = [
  { key: 'fajr', label: 'اذان صبح' },
  { key: 'sunrise', label: 'طلوع آفتاب' },
  { key: 'dhuhr', label: 'اذان ظهر' },
  { key: 'sunset', label: 'غروب آفتاب' },
  { key: 'maghrib', label: 'اذان مغرب' },
  { key: 'midnight', label: 'نیمه‌شب شرعی' },
];

const DAY = 864e5;
const MAX_CITY_DISTANCE_KM = 150; // farther than this from any listed city the place is just "your location"
export const KEYS = {
  position: 'pnu.geo.pos', // { lat, lon, at }: last known position (about 1 km precision), kept in this browser only
  asked: 'pnu.geo.asked', // local day (YYYY-MM-DD) of the last question / refusal: the browser is asked again the next day
};
const CACHE_MAX_AGE = 7 * DAY; // a remembered position older than this is not used
const REFRESH_AFTER = 3 * 36e5; // a granted permission refreshes the position when the remembered one is older than this

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

export const dayKey = (now) => {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

const escapeText = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

// Inner HTML of the card for a view made by the controller: place / event and its time / time left.
export function prayerMarkup(view) {
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
    view = {
      key: current.key, label: current.label, at: current.at, city, province: place?.province ?? null,
      timeText: timeText(current.at, timeZone), countdown: countdownText(current.at - stamp),
    };
  }

  function publish() {
    recompute();
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
        { enableHighAccuracy: false, timeout: 12000, maximumAge: 10 * 60 * 1000 },
      );
    } catch {
      resolve({ ok: false, code: 0 });
    }
  });

  async function locate() {
    const result = await getPosition();
    if (result.ok) {
      const lat = Math.round(result.lat * 100) / 100; // about 1 km is plenty for prayer times
      const lon = Math.round(result.lon * 100) / 100;
      const same = position && position.lat === lat && position.lon === lon;
      position = { lat, lon, ...(same && position.city ? { city: position.city } : {}) };
      positionAt = now();
      write(KEYS.position, JSON.stringify({ ...position, at: positionAt }));
      publish();
    } else if (result.code === 1) { // refused (or the question was dismissed): hide the card and ask again tomorrow
      write(KEYS.asked, dayKey(now()));
      forget();
    } // other errors (no signal, timeout): stay as we are and try on the next visit
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
    if (!geolocation) return;
    const { state, status } = await permissionState();
    if (status && status !== watched) { // the visitor changes the permission in the browser: follow it at once
      watched = status;
      status.addEventListener?.('change', () => { check(); });
    }
    const saved = remembered();
    if (state === 'denied') {
      write(KEYS.asked, dayKey(now()));
      forget();
      return;
    }
    if (state === 'granted') {
      if (!saved || now() - saved.at > REFRESH_AFTER) await locate();
      return;
    }
    // "prompt" (or a browser without the Permissions API): ask at most once a day, and not at all while a recent position is known.
    if (saved && now() - saved.at < DAY) return;
    if (read(KEYS.asked) === dayKey(now())) return;
    write(KEYS.asked, dayKey(now()));
    await locate();
  }

  function tick() {
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
      if (saved) {
        position = { lat: saved.lat, lon: saved.lon, ...(typeof saved.city === 'string' && saved.city ? { city: saved.city } : {}) };
        positionAt = saved.at;
        publish();
      }
      return Boolean(position);
    },
    // Then runs the permission flow (this may ask the visitor).
    async start() {
      this.showRemembered();
      if (timer && !interval) {
        interval = setInterval(tick, 20_000);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); check(); } });
      }
      await check();
    },
    view: () => view,
    tick,
  };
}
