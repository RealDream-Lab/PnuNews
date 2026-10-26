import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth/crypto.js';
import { createSession } from '../src/auth/sessions.js';
import { createPool } from '../src/db.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig();
const settingKeys = [
  'radio_enabled', 'radio_title', 'radio_stream_url', 'radio_nowplaying_url',
  'byline_show_person', 'site_title', 'max_city_admins', 'peer_edit_enabled',
];

test('admin settings validate radio URLs, audit changes, and scope dashboard statistics', async () => {
  const pool = createPool(config.db);
  const suffix = randomBytes(6).toString('hex');
  const userIds = [];
  const newsIds = [];
  let oldSettings;
  const secureConfig = { ...config, publicUrl: 'https://news.pnu.ac.ir' };
  const app = createApp({ pool, config: secureConfig });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function addUser(username, role, regionId) {
    const [result] = await pool.execute(
      `INSERT INTO users (username, password_hash, full_name, role, region_id, is_active, must_change_password)
       VALUES (?, ?, ?, ?, ?, 1, 0)`,
      [username, await hashPassword(`settings-test-password-${suffix}`), username, role, regionId],
    );
    userIds.push(Number(result.insertId));
    const session = await createSession(pool, result.insertId, { ip: '127.0.0.1', get: () => 'admin-settings-test' });
    return { id: Number(result.insertId), cookie: `pnu_session=${session.token}` };
  }

  async function api(url, cookie, { method = 'GET', body } = {}) {
    const response = await fetch(new URL(url, baseUrl), {
      method,
      headers: {
        origin: baseUrl,
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const contentType = response.headers.get('content-type') ?? '';
    return { response, body: contentType.includes('json') ? await response.json() : await response.text() };
  }

  try {
    const [[country]] = await pool.query("SELECT id FROM regions WHERE type = 'country' LIMIT 1");
    const [[province]] = await pool.query("SELECT id FROM regions WHERE type = 'province' ORDER BY id LIMIT 1");
    const [[otherProvince]] = await pool.query("SELECT id FROM regions WHERE type = 'province' AND id <> ? ORDER BY id LIMIT 1", [province.id]);
    const [[root]] = await pool.execute("SELECT id FROM regions WHERE type = 'country' AND parent_id IS NULL LIMIT 1");
    const superAdmin = await addUser(`settings-root-${suffix}`, 'super_admin', root.id);
    const provinceAdmin = await addUser(`settings-province-${suffix}`, 'province_admin', province.id);
    const [settingRows] = await pool.query(`SELECT k, v FROM settings WHERE k IN (?)`, [settingKeys]);
    oldSettings = Object.fromEntries(settingRows.map((row) => [row.k, row.v]));

    const protectedSettings = await api('/api/admin/settings', provinceAdmin.cookie);
    assert.equal(protectedSettings.response.status, 403);
    const categories = await api('/api/admin/categories', provinceAdmin.cookie);
    assert.ok(categories.body.categories.some((item) => item.name === 'آموزشی'));
    const initialConfig = await api('/api/public/config');
    assert.equal(initialConfig.response.status, 200);

    const mixedContent = await api('/api/admin/settings', superAdmin.cookie, {
      method: 'PUT', body: { radio_stream_url: 'http://stream.example/live' },
    });
    assert.equal(mixedContent.response.status, 400);
    assert.match(mixedContent.body.error, /HTTPS/);
    const noStream = await api('/api/admin/settings', superAdmin.cookie, {
      method: 'PUT', body: { radio_enabled: '1', radio_stream_url: '' },
    });
    assert.equal(noStream.response.status, 400);

    const saved = await api('/api/admin/settings', superAdmin.cookie, {
      method: 'PUT', body: {
        radio_enabled: '1', radio_title: 'رادیوی پیکربندی‌شده',
        radio_stream_url: 'https://stream.example/live',
        radio_nowplaying_url: 'https://radio.example/api/nowplaying',
        site_title: 'اخبار آزمون', byline_show_person: '0',
        max_city_admins: 2, peer_edit_enabled: '0',
      },
    });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.body.settings.radio_enabled, '1');
    const publicConfig = await api('/api/public/config');
    assert.deepEqual(publicConfig.body.radio, { enabled: true, title: 'رادیوی پیکربندی شده', stream_url: 'https://stream.example/live' });

    async function insertNews(originRegionId, title, viewCount, status) {
      const [result] = await pool.execute(
        `INSERT INTO news (title, summary, body_html, search_text, status, view_count, origin_region_id, created_by, updated_by)
         VALUES (?, '', '<p>آزمون</p>', ?, ?, ?, ?, ?, ?)`,
        [title, title, status, viewCount, originRegionId, provinceAdmin.id, provinceAdmin.id],
      );
      newsIds.push(Number(result.insertId));
      return Number(result.insertId);
    }
    await insertNews(province.id, 'خبر استان', 3, 'draft');
    await insertNews(country.id, 'خبر کشوری', 4, 'published');
    await insertNews(otherProvince.id, 'خبر استان دیگر', 999, 'published');
    const scopedStats = await api('/api/admin/stats', provinceAdmin.cookie);
    assert.equal(scopedStats.response.status, 200);
    assert.equal(scopedStats.body.counts.total, 2);
    assert.equal(scopedStats.body.counts.views, 7);
    assert.ok(scopedStats.body.most_viewed.every((item) => item.title !== 'خبر استان دیگر'));
    const allStats = await api('/api/admin/stats', superAdmin.cookie);
    assert.equal(allStats.body.counts.total, 3);

    const [auditRows] = await pool.execute(
      "SELECT meta FROM audit_log WHERE user_id = ? AND action = 'settings.update' ORDER BY id DESC LIMIT 1",
      [superAdmin.id],
    );
    const meta = typeof auditRows[0].meta === 'string' ? JSON.parse(auditRows[0].meta) : auditRows[0].meta;
    assert.deepEqual(meta.changed_keys.sort(), settingKeys.sort());
    assert.doesNotMatch(JSON.stringify(meta), /stream\.example|radio\.example/);
  } finally {
    if (newsIds.length) await pool.execute(`DELETE FROM news WHERE id IN (${newsIds.map(() => '?').join(',')})`, newsIds);
    if (userIds.length) await pool.execute(`DELETE FROM users WHERE id IN (${userIds.map(() => '?').join(',')})`, userIds);
    if (oldSettings) {
      for (const [key, value] of Object.entries(oldSettings)) {
        await pool.execute('INSERT INTO settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [key, value]);
      }
    }
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
});
