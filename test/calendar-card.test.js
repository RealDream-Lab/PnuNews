import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createPublicRouter } from '../src/routes/public.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(`${root}package.json`, 'utf8')).version;
const app = readFileSync(`${root}public/reader/app.v${version}.js`, 'utf8');
const css = readFileSync(`${root}public/reader/styles.v${version}.css`, 'utf8');
const calendar = app.slice(app.indexOf('// ---------- Calendar card'), app.indexOf('function openPrayerGate()'));

test('the server tells its time, uncached, and nothing else', async () => {
  const clock = { now: Date.UTC(2026, 4, 16, 8, 30) };
  const site = express();
  site.use(createPublicRouter({ pool: { query: async () => [[], []], execute: async () => [[], []] }, config: { publicUrl: 'https://news.example.ir' }, events: new EventEmitter(), staticAssets: null, clock: () => clock.now }));
  const server = http.createServer(site);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const answer = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/public/time' }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(text) }));
    }).on('error', reject));
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.json, { now: clock.now });
    assert.equal(answer.headers['cache-control'], 'no-store');
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
});

test('the three lines: weekday, Jalali date like «۲۶ اردیبهشت ۱۴۰۵», and the hour and minute in Iran, whatever the phone\'s zone', () => {
  const formats = new Function(`${calendar.slice(calendar.indexOf('const WEEKDAY_FORMAT'), calendar.indexOf('let serverOffset'))}\nreturn { WEEKDAY_FORMAT, JALALI_FORMAT, CLOCK_FORMAT };`)();
  const instant = new Date(Date.UTC(2026, 4, 16, 8, 30)); // 12:00 in Tehran, a Saturday
  assert.equal(formats.WEEKDAY_FORMAT.format(instant), 'شنبه');
  assert.equal(formats.JALALI_FORMAT.format(instant), '۲۶ اردیبهشت ۱۴۰۵');
  assert.equal(formats.CLOCK_FORMAT.format(instant), '۱۲:۰۰');
  const lateEvening = new Date(Date.UTC(2026, 4, 16, 21, 15)); // already the next day in Tehran
  assert.equal(formats.JALALI_FORMAT.format(lateEvening), '۲۷ اردیبهشت ۱۴۰۵');
  assert.equal(formats.WEEKDAY_FORMAT.format(lateEvening), 'یکشنبه');
  assert.equal((calendar.match(/timeZone: 'Asia\/Tehran'/g) ?? []).length, 3, 'all three in Tehran time');
});

test('the card shows the server\'s time: hidden until the server has answered, repainted on the minute, re-asked when the page comes back', () => {
  assert.match(calendar, /let serverOffset = null;/);
  assert.match(calendar, /if \(serverOffset === null\) return false;/);
  assert.match(calendar, /const now = new Date\(serverNow\(\)\);/, 'never the phone\'s own clock directly');
  assert.ok(!/new Date\(\)|Date\.now\(\)\)\s*;?\s*\n\s*calendarNode/.test(calendar.replace(/const serverNow = .*\n/, '')), 'no other reading of the phone clock for the card');
  assert.match(calendar, /setTimeout\(syncPrayerCard, 60_000 - \(serverNow\(\) % 60_000\) \+ 50\)/);
  assert.match(calendar, /fetch\('\/api\/public\/time', \{ cache: 'no-store' \}\)/);
  assert.match(calendar, /serverOffset = now \+ \(Date\.now\(\) - asked\) \/ 2 - Date\.now\(\);/);
  assert.match(calendar, /document\.addEventListener\('visibilitychange', \(\) => \{ if \(!document\.hidden\) syncServerTime\(\); \}\);/);
});

test('the strip order: the account card, then the calendar, then the prayer card, then the news', () => {
  assert.match(app, /const cards = \[showAccount && accountButton, showCalendar && calendarNode, prayerView && prayerNode\]\.filter\(Boolean\);/);
  assert.match(app, /pinnedStrip\.insertBefore\(node, pinnedStrip\.children\[index\] \?\? null\)/);
  assert.match(app, /pinnedStrip\.hidden = !\(cards\.length \|\| pinnedStrip\.querySelector\('\[data-news-id\]'\)\);/);
});

test('the card looks like its neighbours: three lines, as wide as the longest one', () => {
  for (const cls of ['calendar-line', 'calendar-date', 'calendar-time']) assert.ok(calendar.includes(`class="${cls}"`), cls);
  assert.match(css, /\.calendar-card\{[^}]*width:max-content;min-width:9\.5rem;max-width:min\(22rem,88%\)/);
  assert.match(calendar, /<bdi dir="ltr">\$\{escapeHtml\(CLOCK_FORMAT\.format\(now\)\)\}<\/bdi>/);
});
