import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { compactCities } from '../scripts/build-iran-cities.mjs';

// The file name carries the release number, so it is imported through package.json like the other tests do.
const releaseVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
const { KEYS, computeEvents, countdownText, createPrayerCard, dayKey, nearestCity, nextEvent, prayerMarkup, timeText } = await import(`../public/shared/prayer-card.v${releaseVersion}.js`);

const BIJAR = [35.87, 47.6];
const TEHRAN = [35.69, 51.39];
const at = (iso) => Date.parse(iso); // all clock times below are Tehran time (UTC+3:30)
const tehranClock = (ms) => timeText(ms, 'Asia/Tehran');

test('events of one day come out in the natural order with plausible gaps (Tehran, 19 Nov 2026)', () => {
  const noon = at('2026-11-19T12:00:00+03:30');
  const today = computeEvents(noon, ...TEHRAN).filter((event) => event.at > at('2026-11-19T00:00:00+03:30') && event.at < at('2026-11-20T00:00:00+03:30'));
  assert.deepEqual(today.map((event) => event.key), ['fajr', 'sunrise', 'dhuhr', 'sunset', 'maghrib', 'midnight']);
  const by = Object.fromEntries(today.map((event) => [event.key, event.at]));
  const minutes = (a, b) => (by[b] - by[a]) / 6e4;
  assert.ok(minutes('fajr', 'sunrise') > 80 && minutes('fajr', 'sunrise') < 100, 'fajr is about 1.5 h before sunrise in November');
  assert.ok(minutes('sunset', 'maghrib') > 14 && minutes('sunset', 'maghrib') < 22, 'Tehran method: maghrib about 18 min after sunset');
  assert.ok(by.dhuhr > at('2026-11-19T11:30:00+03:30') && by.dhuhr < at('2026-11-19T12:15:00+03:30'));
  assert.ok(by.sunset > at('2026-11-19T16:45:00+03:30') && by.sunset < at('2026-11-19T17:30:00+03:30'));
  assert.ok(by.midnight > by.maghrib && by.midnight < at('2026-11-20T01:00:00+03:30'));
});

test('the next event follows the clock, also across midnight', () => {
  const key = (iso) => nextEvent(at(iso), ...BIJAR).key;
  assert.equal(key('2026-11-19T03:00:00+03:30'), 'fajr');
  assert.equal(key('2026-11-19T06:00:00+03:30'), 'sunrise');
  assert.equal(key('2026-11-19T09:00:00+03:30'), 'dhuhr');
  assert.equal(key('2026-11-19T14:00:00+03:30'), 'sunset');
  assert.equal(key('2026-11-19T17:20:00+03:30'), 'maghrib');
  assert.equal(key('2026-11-19T20:00:00+03:30'), 'midnight');
  assert.equal(key('2026-11-19T23:59:30+03:30'), 'fajr', 'after the Jafari midnight the next one is tomorrow\'s fajr');
  assert.equal(nextEvent(at('2026-11-19T20:00:00+03:30'), ...BIJAR).at > at('2026-11-19T20:00:00+03:30'), true);
});

test('an event of yesterday evening that falls after 00:00 is still found (Jafari midnight in summer)', () => {
  // 21 Jun: sunset is late and fajr early, so the midpoint can land right around/after 00:00.
  const events = computeEvents(at('2026-06-21T00:05:00+03:30'), ...BIJAR);
  const next = events.find((event) => event.at > at('2026-06-21T00:05:00+03:30'));
  assert.ok(['midnight', 'fajr'].includes(next.key));
  assert.ok(next.at - at('2026-06-21T00:05:00+03:30') < 6 * 36e5);
});

test('nearest city: the city itself, a village next to it, and nothing for far-away places', async () => {
  const cities = compactCities(JSON.parse(await readFile('data/IranCities.json', 'utf8'))).cities;
  assert.equal(nearestCity(cities, 35.8734, 47.6051).name, 'بیجار');
  assert.equal(nearestCity(cities, 35.69, 51.39).name, 'تهران');
  assert.equal(nearestCity(cities, 35.9, 47.7).name, 'بیجار');
  assert.equal(nearestCity(cities, 35.68, 139.69), null, 'Tokyo is not near any listed city');
  assert.equal(nearestCity([], 35, 47), null);
});

test('the bundled compact city file is exactly what the build script makes from the source list', async () => {
  const source = JSON.parse(await readFile('data/IranCities.json', 'utf8'));
  const bundled = JSON.parse(await readFile('public/shared/iran-cities.v1.json', 'utf8'));
  assert.deepEqual(bundled, compactCities(source));
  assert.ok(bundled.cities.length > 1000);
  assert.ok(bundled.cities.every(([name, province, lat, lon]) => name && province && lat > 24 && lat < 41 && lon > 43 && lon < 64));
  assert.ok(!bundled.cities.some(([name]) => /[يك]/.test(name)), 'Arabic letters are normalised');
});

test('texts: countdown and markup', () => {
  assert.equal(countdownText(30_000), 'کمتر از یک دقیقه دیگر');
  assert.equal(countdownText(45 * 6e4), '۴۵ دقیقه دیگر');
  assert.equal(countdownText(120 * 6e4), '۲ ساعت دیگر');
  assert.equal(countdownText(135 * 6e4), '۲ ساعت و ۱۵ دقیقه دیگر');
  const html = prayerMarkup({ label: 'اذان ظهر', at: at('2026-11-19T12:00:00+03:30'), timeText: '۱۲:۰۰', countdown: '۱ ساعت دیگر', city: '<b>بیجار</b>' });
  assert.ok(html.includes('اذان ظهر') && html.includes('۱۲:۰۰') && html.includes('&lt;b&gt;'), 'city text is escaped');
  assert.ok(html.indexOf('prayer-place') < html.indexOf('prayer-name') && html.indexOf('prayer-name') < html.indexOf('prayer-left'), 'place, then event and time, then time left');
  assert.ok(!html.includes('<svg') && !html.includes('رویداد بعدی'), 'no icon and no caption');
  assert.ok(prayerMarkup({ label: 'x', at: 0, timeText: '', countdown: '', city: null }).includes('موقعیت شما'));
});

// ---------- The question flow ----------
function world({ state = 'prompt', result = { lat: 35.8734, lon: 47.6051 }, start = at('2026-11-19T10:00:00+03:30'), stored = {}, citiesNever = false } = {}) {
  const clock = { now: start };
  const store = new Map(Object.entries(stored));
  const calls = { position: 0, query: 0 };
  const listeners = new Set();
  const status = { state, addEventListener: (type, listener) => { if (type === 'change') listeners.add(listener); } };
  const views = [];
  const card = createPrayerCard({
    onChange: (view) => views.push(view),
    storage: { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: (key) => store.delete(key) },
    geolocation: {
      getCurrentPosition: (ok, fail) => {
        calls.position += 1;
        if (result.error) fail({ code: result.error }); else ok({ coords: { latitude: result.lat, longitude: result.lon } });
      },
    },
    permissions: { query: async () => { calls.query += 1; return status; } },
    now: () => clock.now,
    loadCities: citiesNever ? () => new Promise(() => {}) : async () => compactCities(JSON.parse(await readFile('data/IranCities.json', 'utf8'))).cities,
    timer: false,
  });
  return { card, clock, store, calls, views, status, listeners, settle: () => new Promise((resolve) => setTimeout(resolve, 20)) };
}

test('allowed: the card shows the next event with the nearest city name, and the position stays in the browser', async () => {
  const w = world();
  await w.card.start();
  await w.settle();
  const view = w.card.view();
  assert.equal(view.key, 'dhuhr');
  assert.equal(view.city, 'بیجار');
  assert.match(view.timeText, /^[۰-۹]{2}:[۰-۹]{2}$/);
  assert.equal(w.calls.position, 1);
  const saved = JSON.parse(w.store.get(KEYS.position));
  assert.deepEqual([saved.lat, saved.lon], [35.87, 47.61], 'rounded to about a kilometre');
});

test('refused: no card, and the browser is not asked again the same day but is asked again the next day', async () => {
  const w = world({ result: { error: 1 } });
  await w.card.start();
  assert.equal(w.card.view(), null);
  assert.equal(w.calls.position, 1);
  assert.equal(w.store.get(KEYS.asked), dayKey(w.clock.now));
  // same day, later visit: not asked
  await w.card.start();
  assert.equal(w.calls.position, 1, 'no second question the same day');
  // next day: asked again
  w.clock.now += 24 * 36e5;
  await w.card.start();
  assert.equal(w.calls.position, 2, 'asked again the next day');
});

test('refusal after an earlier consent removes the remembered position', async () => {
  const w = world({ state: 'denied', stored: { [KEYS.position]: JSON.stringify({ lat: 35.87, lon: 47.6, at: at('2026-11-19T09:00:00+03:30') }) } });
  await w.card.start();
  assert.equal(w.card.view(), null);
  assert.equal(w.store.has(KEYS.position), false);
  assert.equal(w.calls.position, 0, 'a browser-level block is not poked');
});

test('granted: the remembered position shows at once; it is refreshed only when old', async () => {
  const fresh = { [KEYS.position]: JSON.stringify({ lat: 35.87, lon: 47.6, at: at('2026-11-19T09:00:00+03:30') }) };
  const w = world({ state: 'granted', stored: fresh });
  await w.card.start();
  assert.ok(w.views[0], 'published from the remembered position before any question');
  assert.equal(w.calls.position, 0, 'fresh enough: no new position request');
  const old = world({ state: 'granted', stored: { [KEYS.position]: JSON.stringify({ lat: 1, lon: 1, at: at('2026-11-19T04:00:00+03:30') }) } });
  await old.card.start();
  await old.settle();
  assert.equal(old.calls.position, 1);
  assert.equal(old.card.view().city, 'بیجار', 'the new position replaced the old one');
});

test('prompt state with a recent remembered position does not ask again (Safari-style "ask each time")', async () => {
  const w = world({ stored: { [KEYS.position]: JSON.stringify({ lat: 35.87, lon: 47.6, at: at('2026-11-19T08:00:00+03:30') }) } });
  await w.card.start();
  assert.equal(w.calls.position, 0);
  assert.ok(w.card.view());
});

test('a position error that is not a refusal changes nothing and does not count as "asked and refused"', async () => {
  const w = world({ result: { error: 2 } });
  await w.card.start();
  assert.equal(w.card.view(), null);
  assert.equal(w.store.has(KEYS.position), false);
});

test('the visitor changes the permission in the browser settings: the card follows without a reload', async () => {
  const w = world({ state: 'denied' });
  await w.card.start();
  assert.equal(w.card.view(), null);
  w.status.state = 'granted';
  for (const listener of w.listeners) listener();
  await w.settle();
  assert.ok(w.card.view(), 'allowed in the settings: the card appears');
  w.status.state = 'denied';
  for (const listener of w.listeners) listener();
  await w.settle();
  assert.equal(w.card.view(), null, 'blocked in the settings: the card goes');
});

test('a remembered position (with its city) is shown synchronously, before the city list or the permission check', async () => {
  const savedAt = at('2026-11-19T09:00:00+03:30');
  const w = world({ state: 'granted', citiesNever: true, stored: { [KEYS.position]: JSON.stringify({ lat: 35.87, lon: 47.6, at: savedAt, city: 'بیجار' }) } });
  const shown = w.card.showRemembered(); // no await: this is what lets the page paint the card with the first screen
  assert.equal(shown, true);
  assert.equal(w.views.length, 1);
  assert.equal(w.card.view().city, 'بیجار', 'complete from the first moment');
  assert.equal(w.calls.position + w.calls.query, 0, 'nothing asked or awaited');
  assert.equal(w.card.showRemembered(), true, 'calling it twice changes nothing');
  assert.equal(w.views.length, 1);
});

test('without a remembered position showRemembered does nothing', () => {
  assert.equal(world().card.showRemembered(), false);
});

test('the city name is remembered for next time without making the position look fresher', async () => {
  const savedAt = at('2026-11-19T08:00:00+03:30');
  const w = world({ state: 'granted', stored: { [KEYS.position]: JSON.stringify({ lat: 35.87, lon: 47.6, at: savedAt }) } });
  await w.card.start();
  await w.settle();
  const saved = JSON.parse(w.store.get(KEYS.position));
  assert.equal(saved.city, 'بیجار');
  assert.equal(saved.at, savedAt, 'the age of the position is unchanged');
  assert.equal(saved.lat, 35.87);
});

test('a new position far from the remembered one does not keep the old city name', async () => {
  const w = world({ state: 'granted', result: { lat: 35.69, lon: 51.39 }, stored: { [KEYS.position]: JSON.stringify({ lat: 35.87, lon: 47.6, at: at('2026-11-19T04:00:00+03:30'), city: 'بیجار' }) } });
  await w.card.start();
  await w.settle();
  assert.equal(w.card.view().city, 'تهران');
  assert.equal(JSON.parse(w.store.get(KEYS.position)).city, 'تهران');
});

test('the countdown moves on with the clock and switches to the next event when one passes', async () => {
  const w = world({ start: at('2026-11-19T11:00:00+03:30') });
  await w.card.start();
  await w.settle();
  const first = w.card.view();
  assert.equal(first.key, 'dhuhr');
  w.clock.now += 30 * 6e4;
  w.card.tick();
  assert.notEqual(w.card.view().countdown, first.countdown);
  w.clock.now = at('2026-11-19T13:00:00+03:30');
  w.card.tick();
  assert.equal(w.card.view().key, 'sunset', 'dhuhr is over: the next event is the sunset');
});

test('no geolocation API (insecure page, old browser): nothing happens', async () => {
  const views = [];
  const card = createPrayerCard({ onChange: (v) => views.push(v), geolocation: undefined, storage: new Map().constructor === Map ? { getItem: () => null, setItem() {}, removeItem() {} } : null, timer: false });
  await card.start();
  assert.equal(card.view(), null);
});

test('the reader loads the card lazily, keeps clicks away from it and the server allows geolocation for the site itself', async () => {
  const version = JSON.parse(await readFile('package.json', 'utf8')).version;
  const reader = await readFile(`public/reader/app.v${version}.js`, 'utf8');
  assert.ok(reader.includes(`import('/shared/prayer-card.v${version}.js')`));
  assert.ok(!/^import .*prayer-card/m.test(reader), 'not a static import: a missing file must not break the reader');
  assert.ok(!/prayer-card[^\n]*data-news-id/.test(reader));
  const raceAt = reader.indexOf('await Promise.race([prayerReady');
  const stripAt = reader.indexOf('pinnedStrip.innerHTML = pinned.map(pinnedMarkup).join(\'\');', raceAt);
  const gateAt = reader.indexOf('openPrayerGate();', stripAt);
  assert.ok(raceAt > 0 && stripAt > raceAt && gateAt > stripAt, 'the first strip render waits for the card, builds the news cards, then opens the gate for the card in the same step');
  assert.ok(reader.includes('if (!prayerGate) return;'), 'the card is never put into the strip before the first render');
  const app = await readFile('src/app.js', 'utf8');
  assert.ok(app.includes('geolocation=(self)') && !app.includes('geolocation=()'));
  const sw = await readFile('public/sw.js', 'utf8');
  assert.ok(sw.includes(`/shared/prayer-card.v${version}.js`) && sw.includes('/shared/praytime.v3.2.js'));
});
