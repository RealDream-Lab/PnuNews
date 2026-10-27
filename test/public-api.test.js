import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth/crypto.js';
import { createPool } from '../src/db.js';
import { appEvents } from '../src/events.js';
import { loadConfig } from '../src/config.js';
import { createStaticAssets } from '../src/lib/static.js';

const config = loadConfig();

test('public API exposes visible-city feeds, keyset pages, publisher details, radio proxy, and safe OG metadata', async () => {
  const pool = createPool(config.db);
  const suffix = randomBytes(6).toString('hex');
  const newsIds = [];
  let userId;
  let cityId;
  let province;
  let storedName;
  let nowPlayingRequests = 0;
  let testClock = Date.now();
  const staticAssets = await createStaticAssets(fileURLToPath(new URL('../public/', import.meta.url)));
  const app = createApp({
    pool,
    config,
    staticAssets,
    clock: () => testClock,
    fetchImpl: async () => {
      nowPlayingRequests += 1;
      return Response.json({ now_playing: { song: { title: 'قطعهٔ آزمایشی', artist: 'گروه آزمون' } } });
    },
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const originalSettings = await pool.query("SELECT k, v FROM settings WHERE k IN ('site_title','radio_enabled','radio_title','radio_stream_url','radio_nowplaying_url','byline_show_person')");

  async function request(url) {
    const response = await fetch(new URL(url, baseUrl));
    const contentType = response.headers.get('content-type') ?? '';
    return { response, body: contentType.includes('json') ? await response.json() : await response.text() };
  }

  async function createPublishedNews({ title, targetIds, publishedAt, pinned = false, urgent = false, body = '<p>متن خبر</p>' }) {
    const [result] = await pool.execute(
      `INSERT INTO news (title, summary, body_html, search_text, status, published_at, is_pinned, is_urgent,
                         origin_region_id, published_by_user_id, publisher_name, publisher_unit, created_by, updated_by)
       VALUES (?, ?, ?, ?, 'published', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [title, 'خلاصهٔ خبر', body, `${title} خلاصهٔ خبر متن خبر`, publishedAt, pinned ? 1 : 0, urgent ? 1 : 0,
        province.id, userId, 'نام ثابت ناشر', `روابط عمومی استان ${province.name}`, userId, userId],
    );
    newsIds.push(Number(result.insertId));
    for (const targetId of targetIds) {
      await pool.execute('INSERT INTO news_targets (news_id, region_id) VALUES (?, ?)', [result.insertId, targetId]);
    }
    return Number(result.insertId);
  }

  try {
    [[province]] = await pool.query("SELECT id, name FROM regions WHERE type = 'province' ORDER BY id LIMIT 1");
    const [[city]] = await pool.execute("SELECT id, name FROM regions WHERE type = 'city' AND parent_id = ? ORDER BY id LIMIT 1", [province.id]);
    const [[otherCity]] = await pool.execute("SELECT id FROM regions WHERE type = 'city' AND parent_id = ? AND id <> ? ORDER BY id LIMIT 1", [province.id, city.id]);
    const [[country]] = await pool.query("SELECT id FROM regions WHERE type = 'country' LIMIT 1");

    cityId = Number(city.id);
    const [user] = await pool.execute(
      `INSERT INTO users (username, password_hash, full_name, role, region_id, is_active)
       VALUES (?, ?, 'مدیر آزمون', 'city_admin', ?, 1)`,
      [`public-${suffix}`, await hashPassword('public-test-password-2026'), city.id],
    );
    userId = Number(user.insertId);

    const now = Date.now();
    const countryNewsId = await createPublishedNews({ title: 'خبر کشوری آزمون', targetIds: [country.id], publishedAt: new Date(now - 3000) });
    const provinceNewsId = await createPublishedNews({ title: 'خبر <آزمون>', targetIds: [province.id, city.id], publishedAt: new Date(now - 2000), pinned: true, body: '<p>متن <strong>مهم</strong></p><script>bad()</script>' });
    const cityNewsId = await createPublishedNews({ title: 'خبر شهر آزمون', targetIds: [city.id], publishedAt: new Date(now - 1000), urgent: true });
    const privateNewsId = await createPublishedNews({ title: 'خبر شهر دیگر', targetIds: [otherCity.id], publishedAt: new Date(now - 500) });
    const dateFolder = new Date().toISOString().slice(0, 7).replace('-', '/');
    storedName = `img/${dateFolder}/${randomBytes(16).toString('hex')}`;
    const [coverResult] = await pool.execute(
      `INSERT INTO attachments (news_id, kind, original_name, stored_name, mime, size_bytes, width, height, dominant_color)
       VALUES (?, 'cover', 'cover.webp', ?, 'image/webp', 20, 800, 450, '#245fb5')`,
      [provinceNewsId, storedName],
    );
    await pool.execute('UPDATE news SET cover_attachment_id = ? WHERE id = ?', [coverResult.insertId, provinceNewsId]);

    const home = await request('/');
    assert.equal(home.response.status, 200);
    assert.match(home.body, /id="city-picker"/);
    assert.equal(home.response.headers.get('cache-control'), 'no-cache');
    const readerScript = await request('/reader/app.v9.js');
    assert.equal(readerScript.response.headers.get('cache-control'), 'public, max-age=31536000, immutable');

    const configResponse = await request('/api/public/config');
    assert.equal(configResponse.response.status, 200);
    assert.match(configResponse.response.headers.get('content-security-policy'), /media-src 'self' https: http:/);
    const selectedProvince = configResponse.body.provinces.find((item) => Number(item.id) === Number(province.id));
    assert.ok(selectedProvince.cities.some((item) => Number(item.id) === cityId));
    assert.equal(configResponse.body.provinces.length, 31, 'every province is listed, even without an admin');
    assert.ok(configResponse.body.provinces.some((item) => item.cities.length === 0), 'provinces without a city admin are listed with no cities');
    assert.equal(configResponse.body.radio.enabled, false);
    const placeholder = await request('/media/placeholder/245fb5.svg');
    assert.equal(placeholder.response.status, 200);
    assert.match(placeholder.body, /fill="#245fb5"/);
    assert.equal((await request('/media/placeholder/invalid.svg')).response.status, 404);

    const firstPage = await request(`/api/public/feed?city=${cityId}&limit=2`);
    assert.deepEqual(firstPage.body.items.map((item) => item.id), [cityNewsId, provinceNewsId]);
    assert.equal(firstPage.body.items[1].scope.type, 'province');
    assert.deepEqual(firstPage.body.pinned.map((item) => item.id), [cityNewsId, provinceNewsId]);
    assert.ok(firstPage.body.items[1].cover.src.endsWith('-800.webp'));
    assert.ok(firstPage.body.next_cursor);
    const secondPage = await request(`/api/public/feed?city=${cityId}&limit=2&cursor=${encodeURIComponent(firstPage.body.next_cursor)}`);
    assert.deepEqual(secondPage.body.items.map((item) => item.id), [countryNewsId]);
    assert.equal(secondPage.body.next_cursor, null);
    assert.ok(!secondPage.body.items.some((item) => item.id === privateNewsId));
    assert.equal((await request(`/api/public/feed?city=${cityId}&scope=province`)).body.items.length, 1);
    assert.equal((await request(`/api/public/feed?city=${cityId}&scope=country`)).body.items[0].id, countryNewsId);
    assert.equal((await request('/api/public/feed?scope=all')).response.status, 400);
    const freshNewsId = await createPublishedNews({ title: 'خبر تازه', targetIds: [city.id], publishedAt: new Date(Date.now() - 100) });
    appEvents.emit('news.changed', { id: freshNewsId });
    assert.equal((await request(`/api/public/feed?city=${cityId}&limit=2`)).body.items[0].id, freshNewsId);

    await pool.execute("UPDATE settings SET v = '0' WHERE k = 'byline_show_person'");
    const detail = await request(`/api/public/news/${provinceNewsId}`);
    assert.equal(detail.response.status, 200);
    assert.equal(detail.body.item.publisher_name, undefined);
    assert.equal(detail.body.item.publisher_unit, `روابط عمومی استان ${province.name}`);
    assert.doesNotMatch(detail.body.item.body_html, /script|bad\(\)/);
    const viewsAfterFirst = detail.body.item.view_count;
    const repeated = await request(`/api/public/news/${provinceNewsId}`);
    assert.equal(repeated.body.item.view_count, viewsAfterFirst);
    testClock += 30 * 60_000;
    const afterDedupeWindow = await request(`/api/public/news/${provinceNewsId}`);
    assert.equal(afterDedupeWindow.body.item.view_count, viewsAfterFirst + 1);
    const [[storedViewCount]] = await pool.execute('SELECT view_count FROM news WHERE id = ?', [provinceNewsId]);
    assert.equal(Number(storedViewCount.view_count), viewsAfterFirst + 1);

    await pool.execute("UPDATE settings SET v = '1' WHERE k = 'radio_enabled'");
    await pool.execute("UPDATE settings SET v = 'رادیوی آزمون' WHERE k = 'radio_title'");
    await pool.execute("UPDATE settings SET v = 'https://stream.example/audio' WHERE k = 'radio_stream_url'");
    await pool.execute("UPDATE settings SET v = 'https://radio.example/api/nowplaying' WHERE k = 'radio_nowplaying_url'");
    appEvents.emit('settings.changed');
    const radioConfig = await request('/api/public/config');
    assert.deepEqual(radioConfig.body.radio, { enabled: true, title: 'رادیوی آزمون', stream_url: 'https://stream.example/audio' });
    assert.deepEqual((await request('/api/public/radio')).body, { now_playing: { title: 'قطعهٔ آزمایشی', artist: 'گروه آزمون' } });
    assert.deepEqual((await request('/api/public/radio')).body.now_playing.title, 'قطعهٔ آزمایشی');
    assert.equal(nowPlayingRequests, 1);
    await pool.execute("UPDATE settings SET v = '0' WHERE k = 'radio_enabled'");
    appEvents.emit('settings.changed');
    assert.deepEqual((await request('/api/public/radio')).body, { now_playing: null });
    assert.equal(nowPlayingRequests, 1);

    await pool.execute("UPDATE settings SET v = '1' WHERE k = 'byline_show_person'");
    const og = await request(`/n/${provinceNewsId}`);
    assert.equal(og.response.status, 200);
    assert.match(og.body, /property="og:title" content="خبر &lt;آزمون&gt;"/);
    assert.doesNotMatch(og.body, /<meta property="og:title" content="خبر <آزمون>/);
    assert.match(og.body, /property="og:description" content="خلاصهٔ خبر"/);
    assert.ok(og.body.includes(`<meta property="og:image" content="${new URL(`/media/${storedName}-800.webp`, config.publicUrl).href}">`));
    assert.match(og.body, /name="twitter:image"/);
    assert.match(og.body, /<html lang="fa" dir="rtl" data-theme="auto">/);
    assert.match(og.body, /id="city-picker"/);
    assert.match(og.body, /src="\/reader\/app\.v9\.js"/);
    assert.doesNotMatch(og.body, /<script>bad/);
    assert.ok(privateNewsId);
  } finally {
    await Promise.all(originalSettings[0].map(({ k, v }) => pool.execute('UPDATE settings SET v = ? WHERE k = ?', [v, k])));
    if (newsIds.length) await pool.execute(`DELETE FROM news WHERE id IN (${newsIds.map(() => '?').join(',')})`, newsIds);
    if (userId) await pool.execute('DELETE FROM users WHERE id = ?', [userId]);
    server.close();
    await pool.end();
  }
});
