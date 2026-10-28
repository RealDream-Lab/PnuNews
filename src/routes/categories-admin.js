import express from 'express';
import { canManageRegion } from '../auth/policy.js';
import { appEvents } from '../events.js';
import { cleanFaText } from '../lib/fa.js';

function parseId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function writeAudit(connection, actorId, action, entityId, request, meta = null) {
  return connection.execute(
    `INSERT INTO audit_log (user_id, action, entity, entity_id, meta, ip)
     VALUES (?, ?, 'category', ?, ?, ?)`,
    [actorId, action, entityId, meta ? JSON.stringify(meta) : null, request.ip ?? null],
  );
}

function requireSuper(request, response) {
  if (canManageRegion(request.user)) return true;
  response.status(403).json({ error: 'فقط مدیر ارشد می‌تواند دسته‌بندی‌ها را مدیریت کند.' });
  return false;
}

// Mounted at /api/admin/categories (after the authentication middleware).
export function createCategoryAdminRouter({ pool }) {
  const router = express.Router();

  // Everybody who edits news needs the list (the editor's dropdown); the news count is for the manager screen only.
  router.get('/', async (request, response, next) => {
    try {
      const manage = request.query.manage === '1';
      if (manage && !requireSuper(request, response)) return undefined;
      const [rows] = await pool.query(
        `SELECT c.id, c.name, c.sort_order, c.is_active
                ${manage ? ', (SELECT COUNT(*) FROM news n WHERE n.category_id = c.id AND n.deleted_at IS NULL) AS news_count' : ''}
         FROM categories c ORDER BY c.sort_order, c.id`,
      );
      return response.json({
        categories: rows.map((row) => ({
          id: Number(row.id),
          name: row.name,
          sort_order: Number(row.sort_order),
          is_active: Boolean(row.is_active),
          ...(manage ? { news_count: Number(row.news_count) } : {}),
        })),
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/', async (request, response, next) => {
    if (!requireSuper(request, response)) return undefined;
    const name = cleanFaText(request.body?.name);
    if (!name || name.length > 120) return response.status(400).json({ error: 'نام دسته‌بندی باید بین ۱ تا ۱۲۰ نویسه باشد.' });
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [last] = await connection.query('SELECT COALESCE(MAX(sort_order), 0) AS top FROM categories FOR UPDATE');
      const [result] = await connection.execute(
        'INSERT INTO categories (name, sort_order, is_active) VALUES (?, ?, 1)',
        [name, Number(last[0].top) + 1],
      );
      await writeAudit(connection, request.user.id, 'category.create', result.insertId, request, { name });
      await connection.commit();
      appEvents.emit('news.changed', { id: null });
      return response.status(201).json({ id: Number(result.insertId), name });
    } catch (error) {
      await connection.rollback();
      if (error.code === 'ER_DUP_ENTRY') return response.status(409).json({ error: 'دسته‌بندی دیگری با این نام وجود دارد.' });
      return next(error);
    } finally {
      connection.release();
    }
  });

  // Declared before "/:id" so that "reorder" is never read as an id.
  router.post('/reorder', async (request, response, next) => {
    if (!requireSuper(request, response)) return undefined;
    const ids = Array.isArray(request.body?.ids) ? request.body.ids.map(parseId) : [];
    if (!ids.length || ids.some((id) => !id) || new Set(ids).size !== ids.length) {
      return response.status(400).json({ error: 'ترتیب ارسال‌شده معتبر نیست.' });
    }
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [existing] = await connection.query('SELECT id FROM categories FOR UPDATE');
      if (existing.length !== ids.length || existing.some((row) => !ids.includes(Number(row.id)))) {
        await connection.rollback();
        return response.status(409).json({ error: 'فهرست دسته‌بندی‌ها تغییر کرده است؛ صفحه را تازه کنید.' });
      }
      for (const [index, id] of ids.entries()) {
        await connection.execute('UPDATE categories SET sort_order = ? WHERE id = ?', [index + 1, id]);
      }
      await writeAudit(connection, request.user.id, 'category.reorder', null, request, { ids });
      await connection.commit();
      appEvents.emit('news.changed', { id: null });
      return response.json({ ok: true });
    } catch (error) {
      await connection.rollback();
      return next(error);
    } finally {
      connection.release();
    }
  });

  router.patch('/:id', async (request, response, next) => {
    if (!requireSuper(request, response)) return undefined;
    const id = parseId(request.params.id);
    if (!id) return response.status(400).json({ error: 'شناسهٔ دسته‌بندی معتبر نیست.' });
    const keys = Object.keys(request.body ?? {});
    if (!keys.length || keys.some((key) => !['name', 'is_active'].includes(key))) {
      return response.status(400).json({ error: 'فقط نام و وضعیت دسته‌بندی قابل ویرایش است.' });
    }
    const name = request.body.name === undefined ? undefined : cleanFaText(request.body.name);
    const active = request.body.is_active;
    if ((name !== undefined && (!name || name.length > 120)) || (active !== undefined && typeof active !== 'boolean')) {
      return response.status(400).json({ error: 'نام یا وضعیت دسته‌بندی معتبر نیست.' });
    }
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [existing] = await connection.execute('SELECT id FROM categories WHERE id = ? FOR UPDATE', [id]);
      if (!existing.length) {
        await connection.rollback();
        return response.status(404).json({ error: 'دسته‌بندی پیدا نشد.' });
      }
      const fields = [];
      const values = [];
      if (name !== undefined) { fields.push('name = ?'); values.push(name); }
      if (active !== undefined) { fields.push('is_active = ?'); values.push(active ? 1 : 0); }
      await connection.execute(`UPDATE categories SET ${fields.join(', ')} WHERE id = ?`, [...values, id]);
      await writeAudit(connection, request.user.id, 'category.update', id, request, { fields: keys });
      await connection.commit();
      appEvents.emit('news.changed', { id: null });
      return response.json({ ok: true });
    } catch (error) {
      await connection.rollback();
      if (error.code === 'ER_DUP_ENTRY') return response.status(409).json({ error: 'دسته‌بندی دیگری با این نام وجود دارد.' });
      return next(error);
    } finally {
      connection.release();
    }
  });

  // News that used this category are kept and simply become "uncategorised" (ON DELETE SET NULL in the schema).
  router.delete('/:id', async (request, response, next) => {
    if (!requireSuper(request, response)) return undefined;
    const id = parseId(request.params.id);
    if (!id) return response.status(400).json({ error: 'شناسهٔ دسته‌بندی معتبر نیست.' });
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [existing] = await connection.execute('SELECT id, name FROM categories WHERE id = ? FOR UPDATE', [id]);
      if (!existing.length) {
        await connection.rollback();
        return response.status(404).json({ error: 'دسته‌بندی پیدا نشد.' });
      }
      const [counted] = await connection.execute('SELECT COUNT(*) AS total FROM news WHERE category_id = ? AND deleted_at IS NULL', [id]);
      await connection.execute('DELETE FROM categories WHERE id = ?', [id]);
      await writeAudit(connection, request.user.id, 'category.delete', id, request, { name: existing[0].name, news_detached: Number(counted[0].total) });
      await connection.commit();
      appEvents.emit('news.changed', { id: null });
      return response.json({ ok: true, news_detached: Number(counted[0].total) });
    } catch (error) {
      await connection.rollback();
      return next(error);
    } finally {
      connection.release();
    }
  });

  return router;
}
