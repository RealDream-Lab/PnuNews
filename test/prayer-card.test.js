import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { compactCities } from '../scripts/build-iran-cities.mjs';

// The file name carries the release number, so it is imported through package.json like the other tests do.
const releaseVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
const { KEYS, computeEvents, countdownText, createPrayerCard, nearestCity, nextEvent, prayerMarkup, timeText } = await import(`../public/shared/prayer-card.v${releaseVersion}.js`);

const BIJAR = [35.87, 47.6];
const TEHRAN = [35.69, 51.39];
const at = (iso) => Date.parse(iso); // all clock times below are Tehran time (UTC+3:30)
const tehranClock = (ms) => timeText(ms, 'Asia/Tehran');

test('events of one day come out in the natural order with plausible gaps (Tehran, 19 Nov 2026)', () => {
  const noon = at('2026-11-19T12:00:00+03:30');
  const today = computeEvents(noon, ...TEHRAN).filter((event) => event.at > at('2026-11-19T00:00:00+03:30') && event.at < at('2026-11-20T00:00:00+03:30'));
  assert.deepEqual(today.map((event) => event.key), ['fajr', 'sunrise', 'dhuhr', 'asr', 'sunset', 'maghrib', 'isha', 'midnight']);
  const by = Object.fromEntries(today.map((event) => [event.key, event.at]));
  const minutes = (a, b) => (by[b] - by[a]) / 6e4;
  assert.ok(minutes('fajr', 'sunrise') > 80 && minutes('fajr', 'sunrise') < 100, 'fajr is about 1.5 h before sunrise in November');
  assert.ok(minutes('sunset', 'maghrib') > 14 && minutes('sunset', 'maghrib') < 22, 'Tehran method: maghrib about 18 min after sunset');
  assert.ok(by.dhuhr > at('2026-11-19T11:30:00+03:30') && by.dhuhr < at('2026-11-19T12:15:00+03:30'));
  assert.ok(by.sunset > at('2026-11-19T16:45:00+03:30') && by.sunset < at('2026-11-19T17:30:00+03:30'));
  assert.ok(minutes('dhuhr', 'asr') > 150 && minutes('dhuhr', 'asr') < 190, 'asr is about 3 h after dhuhr in November');
  assert.ok(minutes('asr', 'sunset') > 120 && minutes('asr', 'sunset') < 160, 'asr is about 2.3 h before sunset in November');
  assert.ok(minutes('maghrib', 'isha') > 40 && minutes('maghrib', 'isha') < 60, 'Tehran method: isha (14°) about 50 min after maghrib');
  assert.ok(by.isha < by.midnight);
  assert.ok(by.midnight > by.maghrib && by.midnight < at('2026-11-20T01:00:00+03:30'));
});

test('the next event follows the clock, also across midnight', () => {
  const key = (iso) => nextEvent(at(iso), ...BIJAR).key;
  assert.equal(key('2026-11-19T03:00:00+03:30'), 'fajr');
  assert.equal(key('2026-11-19T06:00:00+03:30'), 'sunrise');
  assert.equal(key('2026-11-19T09:00:00+03:30'), 'dhuhr');
  assert.equal(key('2026-11-19T14:00:00+03:30'), 'asr');
  assert.equal(key('2026-11-19T15:30:00+03:30'), 'sunset');
  assert.equal(key('2026-11-19T17:20:00+03:30'), 'maghrib');
  assert.equal(key('2026-11-19T17:40:00+03:30'), 'isha');
  assert.equal(key('2026-11-19T20:00:00+03:30'), 'midnight');
  assert.equal(key('2026-11-19T23:59:30+03:30'), 'fajr', 'after the Jafari midnight the next one is tomorrow\'s fajr');
  assert.equal(nextEvent(at('2026-11-19T20:00:00+03:30'), ...BIJAR).at > at('2026-11-19T20:00:00+03:30'), true);
});

test('after the midnight the next event is called "tomorrow\'s fajr"; before dawn the same fajr is just "fajr"', async () => {
  const label = async (iso) => {
    const w = world({ state: 'granted', start: at(iso), stored: { [KEYS.position]: JSON.stringify({ lat: 35.87, lon: 47.6, at: at(iso) - 6e4, city: 'بیجار' }) } });
    await w.card.start();
    return w.card.view();
  };
  const late = await label('2026-11-19T23:59:30+03:30'); // after the Jafari midnight (about 23:21), before 00:00
  assert.equal(late.key, 'fajr');
  assert.equal(late.label, 'اذان صبح فردا');
  const lateEvening = await label('2026-11-19T20:00:00+03:30');
  assert.equal(lateEvening.label, 'نیمه‌شب شرعی', 'the midnight never gets "tomorrow"');
  const beforeDawn = await label('2026-11-20T03:00:00+03:30');
  assert.equal(beforeDawn.label, 'اذان صبح', 'fajr of the same calendar day');
  const evening = await label('2026-11-19T17:40:00+03:30');
  assert.equal(evening.label, 'اذان عشا');
});

test('the method is the University of Tehran one (fajr 17.7°, maghrib 4.5°, isha 14°, Jafari midnight, standard asr), whatever the library defaults are', async () => {
  const { PrayTime } = await import('../public/shared/praytime.v3.2.js');
  const settings = new PrayTime('Tehran').settings;
  assert.equal(settings.fajr, 17.7);
  assert.equal(settings.maghrib, 4.5);
  assert.equal(settings.isha, 14);
  assert.equal(settings.midnight, 'Jafari');
  assert.equal(settings.asr, 'Standard');
  // and the card really uses that method: Bijar, 19 Nov 2026 (fajr 05:32, maghrib 17:30, isha 18:19 by this method)
  const day = computeEvents(at('2026-11-19T12:00:00+03:30'), ...BIJAR).filter((e) => e.at > at('2026-11-19T00:00:00+03:30') && e.at < at('2026-11-20T00:00:00+03:30'));
  const clock = Object.fromEntries(day.map((e) => [e.key, tehranClock(e.at)]));
  assert.deepEqual([clock.fajr, clock.maghrib, clock.isha], ['۰۵:۳۲', '۱۷:۳۰', '۱۸:۱۹']);
});

test('"tomorrow" is said only before 00:00; from 00:00 the same fajr is plain "اذان صبح", and the word "امروز" is never used', async () => {
  const view = async (iso) => {
    const w = world({ state: 'granted', start: at(iso), stored: { [KEYS.position]: JSON.stringify({ lat: 35.87, lon: 47.6, at: at(iso) - 6e4, city: 'بیجار' }) } });
    await w.card.start();
    return w.card.view();
  };
  assert.equal((await view('2026-11-19T23:59:59+03:30')).label, 'اذان صبح فردا', 'last second before midnight');
  assert.equal((await view('2026-11-20T00:00:00+03:30')).label, 'اذان صبح', 'exactly 00:00');
  assert.equal((await view('2026-11-20T00:00:01+03:30')).label, 'اذان صبح');
  assert.equal((await view('2026-11-20T04:00:00+03:30')).label, 'اذان صبح', 'any time until the fajr itself');
  for (const iso of ['2026-11-19T23:59:59+03:30', '2026-11-20T00:30:00+03:30', '2026-11-19T10:00:00+03:30', '2026-11-19T20:00:00+03:30']) {
    assert.ok(!(await view(iso)).label.includes('امروز'));
  }
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
function world({ state = 'prompt', result: initialResult = { lat: 35.8734, lon: 47.6051 }, start = at('2026-11-19T10:00:00+03:30'), stored = {}, citiesNever = false } = {}) {
  let result = initialResult;
  const clock = { now: start };
  const store = new Map(Object.entries(stored));
  const calls = { position: 0, query: 0, options: [] };
  const listeners = new Set();
  const status = { state, addEventListener: (type, listener) => { if (type === 'change') listeners.add(listener); } };
  const views = [];
  const card = createPrayerCard({
    onChange: (view) => views.push(view),
    storage: { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: (key) => store.delete(key) },
    geolocation: {
      getCurrentPosition: (ok, fail, options) => {
        calls.position += 1;
        calls.options.push(options);
        if (result.error) fail({ code: result.error }); else ok({ coords: { latitude: result.lat, longitude: result.lon } });
      },
    },
    permissions: { query: async () => { calls.query += 1; return status; } },
    now: () => clock.now,
    loadCities: citiesNever ? () => new Promise(() => {}) : async () => compactCities(JSON.parse(await readFile('data/IranCities.json', 'utf8'))).cities,
    timer: false,
  });
  return { card, clock, store, calls, views, status, listeners, moveTo: (next) => { result = next; }, settle: () => new Promise((resolve) => setTimeout(resolve, 20)) };
}

test('a new visitor sees an in-page location button; tapping it requests location and shows the next event', async () => {
  const w = world();
  await w.card.start();
  assert.deepEqual(w.card.view(), { kind: 'location', status: 'prompt' });
  assert.equal(w.calls.position, 0, 'the browser prompt is not launched in the background');
  await w.card.requestLocation();
  await w.settle();
  const view = w.card.view();
  assert.equal(view.key, 'dhuhr');
  assert.equal(view.city, 'بیجار');
  assert.match(view.timeText, /^[۰-۹]{2}:[۰-۹]{2}$/);
  assert.equal(w.calls.position, 1);
  const saved = JSON.parse(w.store.get(KEYS.position));
  assert.deepEqual([saved.lat, saved.lon], [35.87, 47.61], 'rounded to about a kilometre');
});

test('declining the browser prompt keeps the location button visible without re-prompting in the background', async () => {
  const w = world({ result: { error: 1 } });
  await w.card.start();
  await w.card.requestLocation();
  assert.equal(w.card.view().kind, 'location');
  assert.equal(w.card.view().status, 'denied');
  assert.equal(w.calls.position, 1);
  await w.card.start();
  assert.equal(w.calls.position, 1, 'a page revisit does not launch another browser prompt');
});

test('refusal after an earlier consent removes the remembered position', async () => {
  const w = world({ state: 'denied', stored: { [KEYS.position]: JSON.stringify({ lat: 35.87, lon: 47.6, at: at('2026-11-19T09:00:00+03:30') }) } });
  await w.card.start();
  assert.equal(w.card.view().kind, 'location');
  assert.equal(w.card.view().status, 'denied');
  assert.equal(w.store.has(KEYS.position), false);
  assert.equal(w.calls.position, 0, 'a browser-level block is not poked');
});

test('granted: the remembered position shows at once; it is refreshed only when old', async () => {
  const fresh = { [KEYS.position]: JSON.stringify({ lat: 35.87, lon: 47.6, at: at('2026-11-19T09:55:00+03:30') }) };
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

test('prompt state never shows a location left by another visitor or skips the location button', async () => {
  const w = world({ stored: { [KEYS.position]: JSON.stringify({ lat: 35.87, lon: 47.6, at: at('2026-11-19T09:59:00+03:30'), city: 'بیجار' }) } });
  await w.card.start();
  assert.deepEqual(w.card.view(), { kind: 'location', status: 'prompt' });
  assert.equal(w.calls.position, 0);
});

test('a location error leaves a visible retry action', async () => {
  const w = world({ result: { error: 2 } });
  await w.card.start();
  await w.card.requestLocation();
  assert.equal(w.card.view().kind, 'location');
  assert.equal(w.card.view().status, 'error');
  assert.equal(w.store.has(KEYS.position), false);
});

test('the visitor changes the permission in the browser settings: the card follows without a reload', async () => {
  const w = world({ state: 'denied' });
  await w.card.start();
  assert.equal(w.card.view().status, 'denied');
  w.status.state = 'granted';
  for (const listener of w.listeners) listener();
  await w.settle();
  assert.ok(w.card.view(), 'allowed in the settings: the card appears');
  w.status.state = 'denied';
  for (const listener of w.listeners) listener();
  await w.settle();
  assert.equal(w.card.view().status, 'denied', 'blocked in the settings: the location prompt returns');
});

test('a remembered position (with its city) is shown synchronously, before the city list or the permission check', async () => {
  const savedAt = at('2026-11-19T09:55:00+03:30');
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
  const savedAt = at('2026-11-19T09:55:00+03:30');
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
  await w.card.requestLocation();
  await w.settle();
  const first = w.card.view();
  assert.equal(first.key, 'dhuhr');
  w.clock.now += 30 * 6e4;
  w.card.tick();
  assert.notEqual(w.card.view().countdown, first.countdown);
  w.clock.now = at('2026-11-19T13:00:00+03:30');
  w.card.tick();
  assert.equal(w.card.view().key, 'asr', 'dhuhr is over: the next event is the asr');
  w.clock.now = at('2026-11-19T15:30:00+03:30');
  w.card.tick();
  assert.equal(w.card.view().key, 'sunset');
});

test('no geolocation API (insecure page, old browser): nothing happens', async () => {
  const views = [];
  const card = createPrayerCard({ onChange: (v) => views.push(v), geolocation: undefined, storage: new Map().constructor === Map ? { getItem: () => null, setItem() {}, removeItem() {} } : null, timer: false });
  await card.start();
  assert.equal(card.view(), null);
});

test('the reader loads the card only on coarse-pointer devices, ties location permission to a tap, and allows geolocation', async () => {
  const version = JSON.parse(await readFile('package.json', 'utf8')).version;
  const reader = await readFile(`public/reader/app.v${version}.js`, 'utf8');
  assert.ok(reader.includes(`import('/shared/prayer-card.v${version}.js')`));
  assert.ok(reader.includes("matchMedia('(pointer: coarse)')"), 'desktop does not load or show the location card');
  assert.ok(reader.includes('card.requestLocation()'), 'the browser permission flow starts from the visible button');
  assert.ok(!/^import .*prayer-card/m.test(reader), 'not a static import: a missing file must not break the reader');
  assert.ok(!/prayer-card[^\n]*data-news-id/.test(reader));
  const raceAt = reader.indexOf('await Promise.race([Promise.all([prayerReady');
  const stripAt = reader.indexOf('pinnedStrip.innerHTML = pinned.map(pinnedMarkup).join(\'\');', raceAt);
  const gateAt = reader.indexOf('openPrayerGate();', stripAt);
  assert.ok(raceAt > 0 && stripAt > raceAt && gateAt > stripAt, 'the first strip render waits for the card, builds the news cards, then opens the gate for the card in the same step');
  assert.ok(reader.includes('if (!prayerGate) return;'), 'the card is never put into the strip before the first render');
  const app = await readFile('src/app.js', 'utf8');
  assert.ok(app.includes('geolocation=(self)') && !app.includes('geolocation=()'));
  const sw = await readFile('public/sw.js', 'utf8');
  assert.ok(sw.includes(`/shared/prayer-card.v${version}.js`) && sw.includes('/shared/praytime.v3.2.js'));
});

// ---------- A visitor who travels ----------
const BIJAR_AT = { lat: 35.87, lon: 47.6 };

test('travelling: with the permission granted the position is renewed once it is ten minutes old, also while the page stays open', async () => {
  const w = world({ state: 'granted', stored: { [KEYS.position]: JSON.stringify({ ...BIJAR_AT, at: at('2026-11-19T09:55:00+03:30'), city: 'بیجار' }) } });
  await w.card.start();
  assert.equal(w.calls.position, 0, 'five minutes old: still the present place');
  w.clock.now += 6 * 60e3; // 11 minutes since the position was taken
  w.moveTo({ lat: 36.68, lon: 48.5 }); // about 130 km to the north-east
  w.card.tick();
  await w.settle();
  assert.equal(w.calls.position, 1, 'renewed by the tick, without a reload or a new visit');
  const view = w.card.view();
  assert.notEqual(view.city, 'بیجار', 'the place name follows the visitor');
  const saved = JSON.parse(w.store.get(KEYS.position));
  assert.deepEqual([saved.lat, saved.lon], [36.68, 48.5]);
});

test('travelling: the time of the next event is worked out again for the new place, not kept from the old one', async () => {
  const w = world({ state: 'granted', stored: { [KEYS.position]: JSON.stringify({ ...BIJAR_AT, at: at('2026-11-19T09:55:00+03:30') }) } });
  await w.card.start();
  await w.settle();
  const before = { key: w.card.view().key, at: w.card.view().at };
  w.clock.now += 11 * 60e3;
  w.moveTo({ lat: 35.87, lon: 52.0 }); // 4.4 degrees east: the same event comes about 17 minutes earlier
  w.card.tick();
  await w.settle();
  assert.equal(w.card.view().key, before.key);
  assert.ok(before.at - w.card.view().at > 10 * 60e3, 'an event of the old longitude is not kept');
});

test('travelling: a remembered position older than half an hour is not painted before a new one is known', async () => {
  const stored = { [KEYS.position]: JSON.stringify({ ...BIJAR_AT, at: at('2026-11-19T08:00:00+03:30'), city: 'بیجار' }) }; // two hours ago
  const w = world({ state: 'granted', stored, result: { lat: 35.69, lon: 51.39 } });
  assert.equal(w.card.showRemembered(), false, 'it might be another city by now');
  assert.equal(w.views.length, 0);
  await w.card.start();
  await w.settle();
  assert.equal(w.calls.position, 1);
  assert.notEqual(w.card.view().city, 'بیجار');
});

test('travelling: a stale position is never shown when refresh fails', async () => {
  const recent = world({ state: 'granted', result: { error: 2 }, stored: { [KEYS.position]: JSON.stringify({ ...BIJAR_AT, at: at('2026-11-19T08:00:00+03:30'), city: 'بیجار' }) } });
  await recent.card.start();
  assert.equal(recent.card.view().kind, 'location');
  assert.equal(recent.card.view().status, 'error', 'an old location is not presented as current');
  const old = world({ state: 'granted', result: { error: 2 }, stored: { [KEYS.position]: JSON.stringify({ ...BIJAR_AT, at: at('2026-11-19T05:00:00+03:30'), city: 'بیجار' }) } });
  await old.card.start();
  assert.equal(old.card.view().status, 'error');
});

test('travelling: a failing renewal is not repeated every few seconds, and only a fresh answer is accepted from the browser', async () => {
  const w = world({ state: 'granted', result: { error: 2 }, stored: { [KEYS.position]: JSON.stringify({ ...BIJAR_AT, at: at('2026-11-19T09:55:00+03:30') }) } });
  await w.card.start();
  w.clock.now += 11 * 60e3;
  for (let i = 0; i < 5; i += 1) { w.card.tick(); w.clock.now += 20e3; await w.settle(); }
  assert.equal(w.calls.position, 1, 'one attempt in the first two minutes');
  w.clock.now += 2 * 60e3;
  w.card.tick();
  await w.settle();
  assert.equal(w.calls.position, 2, 'then it tries again');
  assert.ok(w.calls.options.every((options) => options.maximumAge <= 60_000 && options.enableHighAccuracy === false), 'a cached answer older than a minute is never accepted');
});

test('travelling: a page that is hidden does not ask for a position', async () => {
  const w = world({ state: 'granted', stored: { [KEYS.position]: JSON.stringify({ ...BIJAR_AT, at: at('2026-11-19T09:55:00+03:30') }) } });
  await w.card.start();
  w.clock.now += 30 * 60e3;
  globalThis.document = { hidden: true };
  try {
    w.card.tick();
    await w.settle();
    assert.equal(w.calls.position, 0);
  } finally {
    delete globalThis.document;
  }
});
