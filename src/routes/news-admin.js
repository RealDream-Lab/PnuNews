import express from 'express';
import { appEvents, emitNewsPublished } from '../events.js';
import { canDeleteNews, canEditNews, canPublishTo, canViewNews, newsVisibilitySql } from '../auth/policy.js';
import { normalizeNewsInput, sanitizeBodyHtml } from '../news/content.js';
import { normalizeFa } from '../lib/fa.js';
import { createNewsAttachmentRouter } from './news-attachments.js';

const NEWS_STATUSES = new Set(['draft', 'scheduled', 'published']);

function idValue(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function cursorEncode(item) {
  const updatedAt = item.updated_at instanceof Date ? item.updated_at.toISOString() : new Date(item.updated_at).toISOString();
  return Buffer.from(JSON.stringify({ updatedAt, id: Number(item.id) })).toString('base64url');
}

function cursorDecode(value) {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    const id = idValue(parsed.id);
    const updatedAt = new Date(parsed.updatedAt);
    if (!id || !Number.isFinite(updatedAt.getTime())) return null;
    return { id, updatedAt };
  } catch {
    return null;
  }
}

function parseDate(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function cleanTitleAndContent(input) {
  const content = normalizeNewsInput(input);
  if (!content.title || content.title.length > 240 || content.summary.length > 600) return null;
  return content;
}

async function loadRegions(pool) {
  const [regions] = await pool.query('SELECT id, parent_id, type, name, code, sort_order FROM regions');
  return regions;
}

async function loadPeerSetting(pool) {
  const [rows] = await pool.execute('SELECT v FROM settings WHERE k = ?', ['peer_edit_enabled']);
  return rows[0]?.v === '1';
}

async function loadNews(pool, id) {
  const [rows] = await pool.execute(
    `SELECT n.*, creator.role AS created_by_role,
            creator.region_id AS created_by_region_id,
            creator.is_active AS created_by_is_active,
            cover.stored_name AS cover_stored_name,
            cover.width AS cover_width, cover.height AS cover_height,
            cover.dominant_color AS cover_dominant_color
     FROM news n
     JOIN users creator ON creator.id = n.created_by
     LEFT JOIN attachments cover ON cover.id = n.cover_attachment_id
     WHERE n.id = ? AND n.deleted_at IS NULL LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

async function loadTargets(pool, newsId) {
  const [rows] = await pool.execute(
    `SELECT r.id, r.parent_id, r.type, r.name
     FROM news_targets nt JOIN regions r ON r.id = nt.region_id
     WHERE nt.news_id = ? ORDER BY r.sort_order, r.id`,
    [newsId],
  );
  return rows;
}

async function validateTargets(pool, user, targetIds, regions, keepIds = []) {
  if (!Array.isArray(targetIds) || targetIds.length > 100) return null;
  const ids = targetIds.map(idValue);
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) return null;
  if (!ids.length) return [];
  const regionMap = new Map(regions.map((region) => [Number(region.id), region]));
  const targets = ids.map((id) => regionMap.get(id));
  const kept = new Set(keepIds.map(Number));
  // Targets already attached to the news were validated when they were added; a moderator (e.g. the
  // central PR user editing a province's news) must be able to keep them even if they could not add them.
  if (targets.some((region) => !region || (!kept.has(Number(region.id)) && !canPublishTo(user, region, regions)))) return null;
  return targets;
}

function editorCanEdit(user, news, peerEditEnabled) {
  return canEditNews(user, news, { regions: news._regions, peerEditEnabled });
}

async function getPolicyNews(pool, user, id) {
  const [news, regions, peerEditEnabled] = await Promise.all([
    loadNews(pool, id),
    loadRegions(pool),
    loadPeerSetting(pool),
  ]);
  if (!news) return null;
  news._regions = regions;
  const canView = canViewNews(user, news, { regions, peerEditEnabled });
  return { news, regions, canView, canEdit: canView && !news.source_url && editorCanEdit(user, news, peerEditEnabled) };
}

function publisherUnit(creatorRole, region) {
  if (region.type === 'country') return creatorRole === 'country_admin' ? 'روابط عمومی سازمان مرکزی' : 'روابط عمومی کل کشور';
  if (region.type === 'province') return `روابط عمومی استان ${region.name}`;
  return `روابط عمومی مرکز دانشگاهی ${region.name}`;
}

function auditNews(connection, userId, action, newsId, request, meta = null) {
  return connection.execute(
    `INSERT INTO audit_log (user_id, action, entity, entity_id, meta, ip)
     VALUES (?, ?, 'news', ?, ?, ?)`,
    [userId, action, newsId, meta ? JSON.stringify(meta) : null, request.ip ?? null],
  );
}

async function updateNewsTargets(connection, newsId, targets) {
  await connection.execute('DELETE FROM news_targets WHERE news_id = ?', [newsId]);
  for (const target of targets) {
    await connection.execute('INSERT INTO news_targets (news_id, region_id) VALUES (?, ?)', [newsId, target.id]);
  }
}

export function createNewsAdminRouter({ pool, clock = Date.now, uploadRoot }) {
  const router = express.Router();

  router.get('/', async (request, response, next) => {
    try {
      const regions = await loadRegions(pool);
      const clauses = ['n.deleted_at IS NULL'];
      const values = [];
      const visibility = newsVisibilitySql(request.user, regions, { peerEditEnabled: await loadPeerSetting(pool) });
      if (visibility) {
        clauses.push(visibility.sql);
        values.push(...visibility.values);
      }
      const status = request.query.status;
      if (status && status !== 'all') {
        if (!NEWS_STATUSES.has(status)) return response.status(400).json({ error: 'وضعیت خبر معتبر نیست.' });
        clauses.push('n.status = ?');
        values.push(status);
      }
      const categoryId = request.query.category ? idValue(request.query.category) : null;
      if (request.query.category && !categoryId) return response.status(400).json({ error: 'دسته‌بندی معتبر نیست.' });
      if (categoryId) { clauses.push('n.category_id = ?'); values.push(categoryId); }
      const regionId = request.query.region ? idValue(request.query.region) : null;
      if (request.query.region && !regionId) return response.status(400).json({ error: 'منطقه معتبر نیست.' });
      if (regionId) {
        clauses.push('EXISTS (SELECT 1 FROM news_targets ntf WHERE ntf.news_id = n.id AND ntf.region_id = ?)');
        values.push(regionId);
      }
      const text = normalizeFa(request.query.text ?? '');
      if (text) { clauses.push('n.search_text LIKE ?'); values.push(`%${text}%`); }
      const scope = request.query.scope ?? (request.query.mine === '1' ? 'mine' : 'all');
      if (!['mine', 'all'].includes(scope)) return response.status(400).json({ error: 'محدودهٔ خبر معتبر نیست.' });
      if (scope === 'mine') { clauses.push('n.created_by = ?'); values.push(request.user.id); }
      const cursor = request.query.cursor ? cursorDecode(request.query.cursor) : null;
      if (request.query.cursor && !cursor) return response.status(400).json({ error: 'نشانگر صفحه معتبر نیست.' });
      if (cursor) {
        clauses.push('(n.updated_at < ? OR (n.updated_at = ? AND n.id < ?))');
        values.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
      }
      const requestedLimit = Number(request.query.limit ?? 20);
      const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(50, requestedLimit)) : 20;
      values.push(limit + 1);
      const [items] = await pool.execute(
        `SELECT n.id, n.title, n.summary, n.category_id, n.status, n.published_at, n.expires_at,
                n.is_pinned, n.is_urgent, n.view_count, n.origin_region_id, n.publisher_name,
                n.publisher_unit, n.source_url, n.created_by, n.updated_at, r.name AS origin_region_name,
                r.type AS origin_region_type, c.name AS category_name,
                cover.stored_name AS cover_stored_name, cover.dominant_color AS cover_dominant_color
         FROM news n JOIN regions r ON r.id = n.origin_region_id
         JOIN users creator ON creator.id = n.created_by
         LEFT JOIN categories c ON c.id = n.category_id
         LEFT JOIN attachments cover ON cover.id = n.cover_attachment_id
         WHERE ${clauses.join(' AND ')}
         ORDER BY n.updated_at DESC, n.id DESC LIMIT ?`,
        values,
      );
      const hasMore = items.length > limit;
      if (hasMore) items.pop();
      let nextCursor = null;
      if (hasMore && items.length) nextCursor = cursorEncode(items.at(-1));
      if (items.length) {
        const ids = items.map((item) => item.id);
        const placeholders = ids.map(() => '?').join(', ');
        const [targets] = await pool.execute(
          `SELECT nt.news_id, r.id, r.name, r.type FROM news_targets nt
           JOIN regions r ON r.id = nt.region_id WHERE nt.news_id IN (${placeholders})
           ORDER BY r.sort_order, r.id`,
          ids,
        );
        const grouped = new Map();
        for (const target of targets) {
          if (!grouped.has(target.news_id)) grouped.set(target.news_id, []);
          grouped.get(target.news_id).push(target);
        }
        for (const item of items) item.targets = grouped.get(item.id) ?? [];
      }
      return response.json({ items, next_cursor: nextCursor });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/', async (request, response, next) => {
    const content = cleanTitleAndContent(request.body ?? {});
    if (!content) return response.status(400).json({ error: 'عنوان یا متن خبر معتبر نیست.' });
    if (request.body?.status && request.body.status !== 'draft') return response.status(400).json({ error: 'خبر را پس از ذخیره از مسیر انتشار منتشر کنید.' });
    const categoryId = request.body?.category_id == null ? null : idValue(request.body.category_id);
    if (!categoryId) return response.status(400).json({ error: 'انتخاب دسته‌بندی الزامی است.' });
    try {
      const regions = await loadRegions(pool);
      const targets = await validateTargets(pool, request.user, request.body?.targets ?? [], regions);
      if (!targets) return response.status(403).json({ error: 'یک یا چند مقصد انتشار مجاز نیست.' });
      if (categoryId) {
        const [categories] = await pool.execute('SELECT id FROM categories WHERE id = ? AND is_active = 1', [categoryId]);
        if (!categories.length) return response.status(400).json({ error: 'دسته‌بندی فعال پیدا نشد.' });
      }
      const connection = await pool.getConnection();
      let newsId;
      try {
        await connection.beginTransaction();
        const [result] = await connection.execute(
          `INSERT INTO news (title, summary, body_html, search_text, category_id, origin_region_id, created_by, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [content.title, content.summary, content.body_html, content.search_text, categoryId, request.user.region_id, request.user.id, request.user.id],
        );
        newsId = result.insertId;
        await updateNewsTargets(connection, newsId, targets);
        await auditNews(connection, request.user.id, 'news.create', newsId, request, { target_ids: targets.map((target) => target.id) });
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
      appEvents.emit('news.changed', { id: Number(newsId) });
      return response.status(201).json({ id: newsId, status: 'draft' });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/:id', async (request, response, next) => {
    const id = idValue(request.params.id);
    if (!id) return response.status(400).json({ error: 'شناسهٔ خبر معتبر نیست.' });
    try {
      const context = await getPolicyNews(pool, request.user, id);
      if (!context?.canView) return response.status(404).json({ error: 'خبر پیدا نشد.' });
      const [attachments] = await pool.execute(
        `SELECT id, kind, original_name, stored_name, mime, size_bytes, width, height, dominant_color, created_at
         FROM attachments WHERE news_id = ? ORDER BY id`,
        [id],
      );
      const news = { ...context.news };
      delete news._regions;
      news.body_html = sanitizeBodyHtml(news.body_html);
      news.targets = await loadTargets(pool, id);
      news.attachments = attachments.map((attachment) => ({
        ...attachment,
        ...(attachment.kind === 'file' ? { url: `/files/${attachment.id}` } : {
          src: `/media/${attachment.stored_name}-800.webp`,
          srcset: [400, 800, 1280].map((width) => `/media/${attachment.stored_name}-${width}.webp ${width}w`).join(', '),
        }),
      }));
      news.can_edit = context.canEdit;
      return response.json({ item: news });
    } catch (error) {
      return next(error);
    }
  });

  router.put('/:id', async (request, response, next) => {
    const id = idValue(request.params.id);
    if (!id) return response.status(400).json({ error: 'شناسهٔ خبر معتبر نیست.' });
    try {
      const context = await getPolicyNews(pool, request.user, id);
      if (!context?.canView) return response.status(404).json({ error: 'خبر پیدا نشد.' });
      if (!context.canEdit) return response.status(403).json({ error: 'اجازهٔ ویرایش این خبر را ندارید.' });
      const content = cleanTitleAndContent({
        title: request.body?.title ?? context.news.title,
        summary: request.body?.summary ?? context.news.summary,
        body_html: request.body?.body_html ?? context.news.body_html,
      });
      if (!content) return response.status(400).json({ error: 'عنوان یا متن خبر معتبر نیست.' });
      const categoryId = request.body?.category_id === undefined ? context.news.category_id : request.body.category_id == null ? null : idValue(request.body.category_id);
      if (!categoryId) return response.status(400).json({ error: 'انتخاب دسته‌بندی الزامی است.' });
      // A category that was deactivated after this news was written may stay on it; only a *change* needs an active one.
      if (categoryId && Number(categoryId) !== Number(context.news.category_id)) {
        const [categories] = await pool.execute('SELECT id FROM categories WHERE id = ? AND is_active = 1', [categoryId]);
        if (!categories.length) return response.status(400).json({ error: 'دسته‌بندی فعال پیدا نشد.' });
      }
      let targets = null;
      if (request.body?.targets !== undefined) {
        const existingTargets = await loadTargets(pool, id);
        targets = await validateTargets(pool, request.user, request.body.targets, context.regions, existingTargets.map((target) => target.id));
        if (!targets) return response.status(403).json({ error: 'یک یا چند مقصد انتشار مجاز نیست.' });
      }
      const expiresAt = request.body?.expires_at === undefined ? context.news.expires_at : parseDate(request.body.expires_at);
      if (expiresAt === undefined) return response.status(400).json({ error: 'زمان انقضا باید تاریخ UTC معتبر باشد.' });
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        await connection.execute(
          `UPDATE news SET title = ?, summary = ?, body_html = ?, search_text = ?, category_id = ?, expires_at = ?, updated_by = ?
           WHERE id = ? AND deleted_at IS NULL`,
          [content.title, content.summary, content.body_html, content.search_text, categoryId, expiresAt, request.user.id, id],
        );
        if (targets) await updateNewsTargets(connection, id, targets);
        await auditNews(connection, request.user.id, 'news.update', id, request, targets ? { target_ids: targets.map((target) => target.id) } : null);
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
      appEvents.emit('news.changed', { id: Number(id) });
      return response.json({ ok: true });
    } catch (error) {
      return next(error);
    }
  });

  router.delete('/:id', async (request, response, next) => {
    const id = idValue(request.params.id);
    if (!id) return response.status(400).json({ error: 'شناسهٔ خبر معتبر نیست.' });
    try {
      const context = await getPolicyNews(pool, request.user, id);
      if (!context?.canView) return response.status(404).json({ error: 'خبر پیدا نشد.' });
      if (!canDeleteNews(request.user, context.news, { regions: context.regions, peerEditEnabled: await loadPeerSetting(pool) })) {
        return response.status(403).json({ error: 'اجازهٔ حذف این خبر را ندارید.' });
      }
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        await connection.execute('UPDATE news SET deleted_at = UTC_TIMESTAMP(), updated_by = ? WHERE id = ?', [request.user.id, id]);
        await auditNews(connection, request.user.id, 'news.delete', id, request);
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
      appEvents.emit('news.changed', { id: Number(id) });
      return response.json({ ok: true });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:id/publish', async (request, response, next) => {
    const id = idValue(request.params.id);
    if (!id) return response.status(400).json({ error: 'شناسهٔ خبر معتبر نیست.' });
    try {
      const context = await getPolicyNews(pool, request.user, id);
      if (!context?.canView) return response.status(404).json({ error: 'خبر پیدا نشد.' });
      if (!context.canEdit) return response.status(403).json({ error: 'اجازهٔ انتشار این خبر را ندارید.' });
      const targets = await loadTargets(pool, id);
      if (!targets.length) {
        return response.status(400).json({ error: 'برای انتشار باید دست‌کم یک مقصد مجاز انتخاب کنید.' });
      }
      const publishedAt = request.body?.published_at === undefined ? new Date(clock()) : parseDate(request.body.published_at);
      const expiresAt = request.body?.expires_at === undefined ? context.news.expires_at : parseDate(request.body.expires_at);
      if (!publishedAt || expiresAt === undefined || (expiresAt && expiresAt <= publishedAt)) {
        return response.status(400).json({ error: 'زمان انتشار یا انقضا معتبر نیست.' });
      }
      const scheduled = publishedAt.getTime() > clock();
      const status = scheduled ? 'scheduled' : 'published';
      const origin = context.regions.find((region) => Number(region.id) === Number(context.news.origin_region_id));
      const unit = publisherUnit(context.news.created_by_role, origin);
      const firstPublish = context.news.published_by_user_id == null;
      const publisherName = firstPublish ? request.user.full_name : context.news.publisher_name;
      const publisherUnitSnapshot = firstPublish ? unit : context.news.publisher_unit;
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        await connection.execute(
          `UPDATE news SET status = ?, published_at = ?, expires_at = ?,
             published_by_user_id = COALESCE(published_by_user_id, ?),
             publisher_name = ?, publisher_unit = ?, updated_by = ?
           WHERE id = ? AND deleted_at IS NULL`,
          [status, publishedAt, expiresAt, request.user.id, publisherName, publisherUnitSnapshot, request.user.id, id],
        );
        await auditNews(connection, request.user.id, scheduled ? 'news.schedule' : 'news.publish', id, request, { published_at: publishedAt.toISOString(), expires_at: expiresAt?.toISOString() ?? null });
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
      if (!scheduled) emitNewsPublished(appEvents, id);
      appEvents.emit('news.changed', { id: Number(id) });
      return response.json({ ok: true, status, published_at: publishedAt.toISOString() });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:id/unpublish', async (request, response, next) => {
    const id = idValue(request.params.id);
    if (!id) return response.status(400).json({ error: 'شناسهٔ خبر معتبر نیست.' });
    try {
      const context = await getPolicyNews(pool, request.user, id);
      if (!context?.canView) return response.status(404).json({ error: 'خبر پیدا نشد.' });
      if (!context.canEdit) return response.status(403).json({ error: 'اجازهٔ لغو انتشار این خبر را ندارید.' });
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        await connection.execute("UPDATE news SET status = 'draft', updated_by = ? WHERE id = ?", [request.user.id, id]);
        await auditNews(connection, request.user.id, 'news.unpublish', id, request);
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
      appEvents.emit('news.changed', { id: Number(id) });
      return response.json({ ok: true });
    } catch (error) {
      return next(error);
    }
  });

  for (const flag of ['pin', 'urgent']) {
    router.post(`/:id/${flag}`, async (request, response, next) => {
      const id = idValue(request.params.id);
      if (!id) return response.status(400).json({ error: 'شناسهٔ خبر معتبر نیست.' });
      const field = flag === 'pin' ? 'is_pinned' : 'is_urgent';
      try {
        const context = await getPolicyNews(pool, request.user, id);
        if (!context?.canView) return response.status(404).json({ error: 'خبر پیدا نشد.' });
        if (!context.canEdit) return response.status(403).json({ error: 'اجازهٔ تغییر وضعیت این خبر را ندارید.' });
        const enabled = request.body?.enabled === undefined ? !Boolean(context.news[field]) : request.body.enabled;
        if (typeof enabled !== 'boolean') return response.status(400).json({ error: 'مقدار باید درست یا نادرست باشد.' });
        const connection = await pool.getConnection();
        try {
          await connection.beginTransaction();
          await connection.execute(`UPDATE news SET ${field} = ?, updated_by = ? WHERE id = ?`, [enabled ? 1 : 0, request.user.id, id]);
          await auditNews(connection, request.user.id, `news.${flag}`, id, request, { enabled });
          await connection.commit();
        } catch (error) {
          await connection.rollback();
          throw error;
        } finally {
          connection.release();
        }
        appEvents.emit('news.changed', { id: Number(id) });
        return response.json({ ok: true, enabled });
      } catch (error) {
        return next(error);
      }
    });
  }

  router.use(createNewsAttachmentRouter({ pool, uploadRoot }));

  router.use((error, request, response, next) => {
    console.error(`News management request failed: ${error.message}`);
    if (response.headersSent) return next(error);
    return response.status(500).json({ error: 'خطای داخلی رخ داد.' });
  });

  return router;
}
