import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { appEvents } from '../src/events.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth/crypto.js';
import { createSession } from '../src/auth/sessions.js';
import { createPool } from '../src/db.js';
import { createScheduler } from '../src/scheduler.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig();

test('news API sanitizes, enforces targets, snapshots publisher data, schedules, and soft-deletes', async () => {
  const pool = createPool(config.db);
  const suffix = randomBytes(6).toString('hex');
  const newsIds = [];
  const attachmentIds = [];
  let userId;
  const publishedEvents = [];
  const onPublished = (event) => publishedEvents.push(event.id);
  appEvents.on('news.published', onPublished);
  const app = createApp({ pool, config });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function api(path, { method = 'GET', body } = {}) {
    const response = await fetch(new URL(path, baseUrl), {
      method,
      headers: {
        origin: baseUrl,
        cookie: `pnu_session=${sessionToken}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { response, json: await response.json() };
  }

  async function upload(newsId, form) {
    const response = await fetch(new URL(`/api/admin/news/${newsId}/attachments`, baseUrl), {
      method: 'POST',
      headers: { origin: baseUrl, cookie: `pnu_session=${sessionToken}` },
      body: form,
    });
    return { response, json: await response.json() };
  }

  let sessionToken;
  try {
    const [[province]] = await pool.query("SELECT id, name FROM regions WHERE type = 'province' ORDER BY id LIMIT 1");
    const [[country]] = await pool.query("SELECT id FROM regions WHERE type = 'country' LIMIT 1");
    const [[category]] = await pool.query('SELECT id FROM categories WHERE is_active = 1 ORDER BY sort_order LIMIT 1');
    const [user] = await pool.execute(
      `INSERT INTO users (username, password_hash, full_name, role, region_id, is_active)
       VALUES (?, ?, 'ناشر نخست', 'province_admin', ?, 1)`,
      [`news-${suffix}`, await hashPassword('news-test-password-2026'), province.id],
    );
    userId = user.insertId;
    const session = await createSession(pool, userId, { ip: '127.0.0.1', get: () => 'news-flow-test' });
    sessionToken = session.token;

    const forbiddenTarget = await api('/api/admin/news', { method: 'POST', body: {
      title: 'خبر غیرمجاز', summary: '', body_html: '<p>متن</p>', targets: [country.id],
    } });
    assert.equal(forbiddenTarget.response.status, 403);

    const createBody = {
      title: 'خبر آزمون ۱۲',
      summary: 'خلاصهٔ خبر',
      body_html: '<p onclick="bad()">متن <strong>مهم</strong></p><script>bad()</script><img src="https://evil.invalid/x">',
      category_id: category.id,
      targets: [province.id],
    };
    const first = await api('/api/admin/news', { method: 'POST', body: createBody });
    const second = await api('/api/admin/news', { method: 'POST', body: { ...createBody, title: 'خبر دوم' } });
    assert.equal(first.response.status, 201);
    assert.equal(second.response.status, 201);
    newsIds.push(first.json.id, second.json.id);

    const firstPage = await api('/api/admin/news?status=draft&limit=1');
    assert.equal(firstPage.json.items.length, 1);
    assert.ok(firstPage.json.next_cursor);
    const secondPage = await api(`/api/admin/news?status=draft&limit=1&cursor=${encodeURIComponent(firstPage.json.next_cursor)}`);
    assert.equal(secondPage.json.items.length, 1);
    assert.notEqual(firstPage.json.items[0].id, secondPage.json.items[0].id);

    const imageBuffer = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#245fb5' } }).jpeg().toBuffer();
    const form = new FormData();
    form.append('cover', new Blob([imageBuffer], { type: 'image/jpeg' }), 'cover.jpg');
    form.append('file', new Blob([Buffer.from('%PDF-1.7\\nAttachment test')], { type: 'application/pdf' }), 'notice.pdf');
    const uploaded = await upload(first.json.id, form);
    assert.equal(uploaded.response.status, 201, JSON.stringify(uploaded.json));
    assert.equal(uploaded.json.attachments.length, 2);
    attachmentIds.push(...uploaded.json.attachments.map((attachment) => attachment.id));
    const cover = uploaded.json.attachments[0];
    const file = uploaded.json.attachments[1];
    assert.equal(cover.kind, 'cover');
    assert.equal(file.kind, 'file');
    const unavailableCover = await fetch(new URL(cover.src, baseUrl));
    assert.equal(unavailableCover.status, 404);
    const detail = await api(`/api/admin/news/${first.json.id}`);
    assert.equal(detail.response.status, 200);
    assert.doesNotMatch(detail.json.item.body_html, /onclick|script|evil\.invalid/);
    assert.equal(detail.json.item.targets[0].id, province.id);
    assert.equal(detail.json.item.attachments.length, 2);
    const pin = await api(`/api/admin/news/${first.json.id}/pin`, { method: 'POST', body: { enabled: true } });
    assert.equal(pin.json.enabled, true);
    const urgent = await api(`/api/admin/news/${first.json.id}/urgent`, { method: 'POST', body: {} });
    assert.equal(urgent.json.enabled, true);

    const immediate = await api(`/api/admin/news/${first.json.id}/publish`, { method: 'POST', body: {} });
    assert.equal(immediate.json.status, 'published');
    assert.deepEqual(publishedEvents, [Number(first.json.id)]);
    const publicCover = await fetch(new URL(cover.src, baseUrl));
    assert.equal(publicCover.status, 200, `media URL ${cover.src}`);
    assert.equal(publicCover.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    const coverMetadata = await sharp(Buffer.from(await publicCover.arrayBuffer())).metadata();
    assert.equal(coverMetadata.format, 'webp');
    assert.equal(coverMetadata.exif, undefined);
    const publicFile = await fetch(new URL(file.url, baseUrl));
    assert.equal(publicFile.status, 200);
    assert.equal(publicFile.headers.get('x-content-type-options'), 'nosniff');
    assert.match(publicFile.headers.get('content-disposition'), /attachment/);
    assert.match(await publicFile.text(), /PDF-1\.7/);
    const [[snapshot]] = await pool.execute(
      'SELECT published_by_user_id, publisher_name, publisher_unit FROM news WHERE id = ?',
      [first.json.id],
    );
    assert.equal(Number(snapshot.published_by_user_id), Number(userId));
    assert.equal(snapshot.publisher_name, 'ناشر نخست');
    assert.equal(snapshot.publisher_unit, `روابط عمومی استان ${province.name}`);

    await pool.execute("UPDATE users SET full_name = 'ناشر تغییرنام‌یافته' WHERE id = ?", [userId]);
    await api(`/api/admin/news/${first.json.id}/unpublish`, { method: 'POST', body: {} });
    await api(`/api/admin/news/${first.json.id}/publish`, { method: 'POST', body: {} });
    const [[unchangedSnapshot]] = await pool.execute('SELECT publisher_name, publisher_unit FROM news WHERE id = ?', [first.json.id]);
    assert.equal(unchangedSnapshot.publisher_name, 'ناشر نخست');
    assert.equal(unchangedSnapshot.publisher_unit, `روابط عمومی استان ${province.name}`);
    assert.equal(publishedEvents.length, 2);

    const scheduledAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const scheduled = await api(`/api/admin/news/${second.json.id}/publish`, { method: 'POST', body: { published_at: scheduledAt } });
    assert.equal(scheduled.json.status, 'scheduled');
    assert.equal(publishedEvents.length, 2);
    await pool.execute('UPDATE news SET published_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE) WHERE id = ?', [second.json.id]);
    const scheduler = createScheduler(pool, { events: appEvents });
    assert.deepEqual(await scheduler.runOnce(), [Number(second.json.id)]);
    assert.equal(publishedEvents.length, 3);
    assert.deepEqual(await scheduler.runOnce(), []);

    for (const attachmentId of attachmentIds) {
      const removedAttachment = await api(`/api/admin/attachments/${attachmentId}`, { method: 'DELETE', body: {} });
      assert.equal(removedAttachment.json.ok, true);
    }
    const deleted = await api(`/api/admin/news/${second.json.id}`, { method: 'DELETE', body: {} });
    assert.equal(deleted.response.status, 200, JSON.stringify(deleted.json));
    assert.equal(deleted.json.ok, true);
    const [[deletedState]] = await pool.execute('SELECT deleted_at FROM news WHERE id = ?', [second.json.id]);
    assert.ok(deletedState.deleted_at);
  } finally {
    appEvents.off('news.published', onPublished);
    if (newsIds.length) {
      const placeholders = newsIds.map(() => '?').join(', ');
      const [attachments] = await pool.execute(`SELECT stored_name, mime FROM attachments WHERE news_id IN (${placeholders})`, newsIds);
      const root = path.resolve(config.uploadDir);
      for (const attachment of attachments) {
        const files = attachment.mime === 'image/webp'
          ? [400, 800, 1280].map((width) => path.join(root, `${attachment.stored_name}-${width}.webp`))
          : [path.join(root, attachment.stored_name)];
        await Promise.all(files.map((filePath) => rm(filePath, { force: true })));
      }
      await pool.execute(`DELETE FROM news WHERE id IN (${placeholders})`, newsIds);
    }
    if (userId) await pool.execute('DELETE FROM users WHERE id = ?', [userId]);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
});
