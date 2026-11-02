import express from 'express';
import { canManageRegion } from '../auth/policy.js';
import { cleanFaText } from '../lib/fa.js';

function parseId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function writeAudit(connection, actorId, action, entityId, request, meta = null) {
  return connection.execute(
    `INSERT INTO audit_log (user_id, action, entity, entity_id, meta, ip)
     VALUES (?, ?, 'domain', ?, ?, ?)`,
    [actorId, action, entityId, meta ? JSON.stringify(meta) : null, request.ip ?? null],
  );
}

function requireSuper(request, response) {
  if (canManageRegion(request.user)) return true;
  response.status(403).json({ error: 'فقط مدیر ارشد می‌تواند حوزه‌ها را مدیریت کند.' });
  return false;
}

// Mounted at /api/admin/domains (after the authentication middleware).
// Work domains (آموزش، امتحانات، شهریه، …) are defined by the main admin; every unit admin picks from the active
// ones when creating a domain user, so the list itself is readable by all admins and only changing it is not.
export function createDomainAdminRouter({ pool }) {
  const router = express.Router();

  router.get('/', async (request, response, next) => {
    try {
      const manage = request.query.manage === '1';
      if (manage && !requireSuper(request, response)) return undefined;
      const [rows] = await pool.query(
        `SELECT d.id, d.name, d.sort_order, d.is_active
                ${manage ? ', (SELECT COUNT(*) FROM users u WHERE u.domain_id = d.id) AS users_count' : ''}
         FROM work_domains d ORDER BY d.sort_order, d.id`,
      );
      return response.json({
        domains: rows.map((row) => ({
          id: Number(row.id),
          name: row.name,
          sort_order: Number(row.sort_order),
          is_active: Boolean(row.is_active),
          ...(manage ? { users_count: Number(row.users_count) } : {}),
        })),
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/', async (request, response, next) => {
    if (!requireSuper(request, response)) return undefined;
    const name = cleanFaText(request.body?.name);
    if (!name || name.length > 120) return response.status(400).json({ error: 'نام حوزه باید بین ۱ تا ۱۲۰ نویسه باشد.' });
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [last] = await connection.query('SELECT COALESCE(MAX(sort_order), 0) AS top FROM work_domains FOR UPDATE');
      const [result] = await connection.execute(
        'INSERT INTO work_domains (name, sort_order, is_active) VALUES (?, ?, 1)',
        [name, Number(last[0].top) + 1],
      );
      await writeAudit(connection, request.user.id, 'domain.create', result.insertId, request, { name });
      await connection.commit();
      return response.status(201).json({ id: Number(result.insertId), name });
    } catch (error) {
      await connection.rollback();
      if (error.code === 'ER_DUP_ENTRY') return response.status(409).json({ error: 'حوزهٔ دیگری با این نام وجود دارد.' });
      return next(error);
    } finally {
      connection.release();
    }
  });

  router.patch('/:id', async (request, response, next) => {
    if (!requireSuper(request, response)) return undefined;
    const id = parseId(request.params.id);
    if (!id) return response.status(400).json({ error: 'شناسهٔ حوزه معتبر نیست.' });
    const keys = Object.keys(request.body ?? {});
    if (!keys.length || keys.some((key) => !['name', 'is_active'].includes(key))) {
      return response.status(400).json({ error: 'فقط نام و وضعیت حوزه قابل ویرایش است.' });
    }
    const name = request.body.name === undefined ? undefined : cleanFaText(request.body.name);
    const active = request.body.is_active;
    if ((name !== undefined && (!name || name.length > 120)) || (active !== undefined && typeof active !== 'boolean')) {
      return response.status(400).json({ error: 'نام یا وضعیت حوزه معتبر نیست.' });
    }
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [existing] = await connection.execute('SELECT id FROM work_domains WHERE id = ? FOR UPDATE', [id]);
      if (!existing.length) {
        await connection.rollback();
        return response.status(404).json({ error: 'حوزه پیدا نشد.' });
      }
      const fields = [];
      const values = [];
      if (name !== undefined) { fields.push('name = ?'); values.push(name); }
      if (active !== undefined) { fields.push('is_active = ?'); values.push(active ? 1 : 0); }
      await connection.execute(`UPDATE work_domains SET ${fields.join(', ')} WHERE id = ?`, [...values, id]);
      await writeAudit(connection, request.user.id, 'domain.update', id, request, { fields: keys });
      await connection.commit();
      return response.json({ ok: true });
    } catch (error) {
      await connection.rollback();
      if (error.code === 'ER_DUP_ENTRY') return response.status(409).json({ error: 'حوزهٔ دیگری با این نام وجود دارد.' });
      return next(error);
    } finally {
      connection.release();
    }
  });

  // A domain that has (or had) users cannot be deleted: deactivate it instead, so the history stays readable.
  router.delete('/:id', async (request, response, next) => {
    if (!requireSuper(request, response)) return undefined;
    const id = parseId(request.params.id);
    if (!id) return response.status(400).json({ error: 'شناسهٔ حوزه معتبر نیست.' });
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [existing] = await connection.execute('SELECT id, name FROM work_domains WHERE id = ? FOR UPDATE', [id]);
      if (!existing.length) {
        await connection.rollback();
        return response.status(404).json({ error: 'حوزه پیدا نشد.' });
      }
      const [used] = await connection.execute('SELECT COUNT(*) AS total FROM users WHERE domain_id = ?', [id]);
      if (Number(used[0].total) > 0) {
        await connection.rollback();
        return response.status(409).json({ error: 'این حوزه کاربر دارد و حذف نمی‌شود؛ در صورت نیاز آن را غیرفعال کنید.' });
      }
      await connection.execute('DELETE FROM work_domains WHERE id = ?', [id]);
      await writeAudit(connection, request.user.id, 'domain.delete', id, request, { name: existing[0].name });
      await connection.commit();
      return response.json({ ok: true });
    } catch (error) {
      await connection.rollback();
      return next(error);
    } finally {
      connection.release();
    }
  });

  return router;
}
