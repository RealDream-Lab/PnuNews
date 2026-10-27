import { randomBytes } from 'node:crypto';
import express from 'express';
import { hashPassword } from '../auth/crypto.js';
import { canCreateUser, canManageRegion, canManageUser, allowedPublishTargets, adminRegionIds } from '../auth/policy.js';
import { createAuthMiddleware, requirePasswordChanged } from './auth.js';
import { cleanFaText } from '../lib/fa.js';
import { appEvents } from '../events.js';
import { createNewsAdminRouter } from './news-admin.js';
import { createAttachmentDeleteRouter } from './news-attachments.js';
import { createCategoryAdminRouter } from './categories-admin.js';

const USERNAME_PATTERN = /^[\p{L}\p{N}_.-]{3,80}$/u;
const VISIBILITY_VALUES = new Set(['auto', 'show', 'hide']);
const MANAGE_ROUTES = new Set(['deactivate', 'activate', 'reset-password', 'reset-2fa']);
const ADMIN_SETTING_KEYS = new Set([
  'radio_enabled', 'radio_title', 'radio_stream_url', 'radio_nowplaying_url',
  'byline_show_person', 'site_title', 'max_city_admins', 'peer_edit_enabled',
]);

function temporaryPassword() {
  return `${randomBytes(15).toString('base64url')}A7`;
}

function safeUser(user) {
  return {
    id: user.id,
    username: user.username,
    full_name: user.full_name,
    role: user.role,
    region_id: user.region_id,
    region_name: user.region_name,
    region_type: user.region_type,
    parent_region_id: user.parent_region_id,
    created_by: user.created_by,
    is_active: Boolean(user.is_active),
    must_change_password: Boolean(user.must_change_password),
    totp_enabled: Boolean(user.totp_enabled),
    last_login_at: user.last_login_at,
    created_at: user.created_at,
  };
}

async function getRegions(pool) {
  const [regions] = await pool.query('SELECT id, parent_id, type, name, code, sort_order, visibility_override FROM regions ORDER BY sort_order, id');
  return regions;
}

async function loadManagedUser(pool, targetId, actor, regions, action) {
  const [rows] = await pool.execute(
    `SELECT u.id, u.username, u.full_name, u.role, u.region_id, u.created_by, u.is_active,
            u.must_change_password, u.totp_enabled, u.last_login_at, u.created_at,
            r.name AS region_name, r.type AS region_type, r.parent_id AS parent_region_id
     FROM users u JOIN regions r ON r.id = u.region_id WHERE u.id = ? LIMIT 1`,
    [targetId],
  );
  const target = rows[0];
  return target && canManageUser(actor, target, action, regions) ? target : null;
}

function parseId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function writeAudit(connection, actorId, action, entity, entityId, request, meta = null) {
  return connection.execute(
    `INSERT INTO audit_log (user_id, action, entity, entity_id, meta, ip)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [actorId, action, entity, entityId, meta ? JSON.stringify(meta) : null, request.ip ?? null],
  );
}

export function createAdminRouter({ pool, config, clock = Date.now, uploadRoot }) {
  const router = express.Router();
  router.use(createAuthMiddleware(pool, config), requirePasswordChanged);
  router.use('/news', createNewsAdminRouter({ pool, clock, uploadRoot }));
  router.use('/attachments', createAttachmentDeleteRouter({ pool, uploadRoot }));
  router.use('/categories', createCategoryAdminRouter({ pool }));

  router.get('/settings', async (request, response, next) => {
    if (!canManageRegion(request.user)) return response.status(403).json({ error: 'فقط مدیر ارشد می‌تواند تنظیمات سامانه را ببیند.' });
    try {
      const [rows] = await pool.query('SELECT k, v FROM settings WHERE k IN (?)', [[...ADMIN_SETTING_KEYS]]);
      return response.json({ settings: Object.fromEntries(rows.map((row) => [row.k, row.v])) });
    } catch (error) {
      return next(error);
    }
  });

  router.put('/settings', async (request, response, next) => {
    if (!canManageRegion(request.user)) return response.status(403).json({ error: 'فقط مدیر ارشد می‌تواند تنظیمات سامانه را تغییر دهد.' });
    const submitted = request.body ?? {};
    const keys = Object.keys(submitted);
    if (!keys.length || keys.some((key) => !ADMIN_SETTING_KEYS.has(key))) {
      return response.status(400).json({ error: 'تنظیمات ارسالی معتبر نیست.' });
    }
    try {
      const [rows] = await pool.query('SELECT k, v FROM settings WHERE k IN (?)', [[...ADMIN_SETTING_KEYS]]);
      const current = Object.fromEntries(rows.map((row) => [row.k, row.v]));
      const updates = {};
      for (const key of keys) {
        const value = submitted[key];
        if (['radio_enabled', 'byline_show_person', 'peer_edit_enabled'].includes(key)) {
          const normalized = value === true ? '1' : value === false ? '0' : String(value);
          if (!['0', '1'].includes(normalized)) return response.status(400).json({ error: `مقدار تنظیم «${key}» باید روشن یا خاموش باشد.` });
          updates[key] = normalized;
        } else if (key === 'max_city_admins') {
          const number = Number(value);
          if (!Number.isSafeInteger(number) || number < 1 || number > 10_000) return response.status(400).json({ error: 'حداکثر مدیران مرکز دانشگاهی باید عددی بین ۱ تا ۱۰۰۰۰ باشد.' });
          updates[key] = String(number);
        } else if (key === 'radio_stream_url' || key === 'radio_nowplaying_url') {
          if (typeof value !== 'string' || value.length > 2048) return response.status(400).json({ error: 'نشانی رادیو معتبر نیست.' });
          const trimmed = value.trim();
          if (trimmed) {
            let url;
            try { url = new URL(trimmed); } catch { return response.status(400).json({ error: 'نشانی رادیو باید یک URL معتبر HTTP یا HTTPS باشد.' }); }
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
              return response.status(400).json({ error: 'فقط نشانی HTTP یا HTTPS بدون اطلاعات ورود پذیرفته می‌شود.' });
            }
            if (config.publicUrl.startsWith('https://') && url.protocol === 'http:') {
              return response.status(400).json({ error: 'در سایت امن HTTPS، نشانی HTTP رادیو به‌دلیل محتوای ناامن پذیرفته نمی‌شود.' });
            }
            updates[key] = url.href;
          } else updates[key] = '';
        } else if (key === 'radio_title' || key === 'site_title') {
          if (typeof value !== 'string') return response.status(400).json({ error: 'عنوان سامانه یا رادیو معتبر نیست.' });
          const normalized = cleanFaText(value);
          if (normalized.length > 160 || (key === 'site_title' && !normalized)) return response.status(400).json({ error: 'عنوان سامانه یا رادیو معتبر نیست.' });
          updates[key] = normalized;
        }
      }
      const candidate = { ...current, ...updates };
      if (candidate.radio_enabled === '1') {
        if (!candidate.radio_stream_url) return response.status(400).json({ error: 'برای فعال‌کردن رادیو، ابتدا نشانی پخش معتبر را وارد کنید.' });
        let streamUrl;
        try { streamUrl = new URL(candidate.radio_stream_url); } catch { return response.status(400).json({ error: 'نشانی پخش رادیو معتبر نیست.' }); }
        if (!['http:', 'https:'].includes(streamUrl.protocol) || streamUrl.username || streamUrl.password || (config.publicUrl.startsWith('https://') && streamUrl.protocol === 'http:')) {
          return response.status(400).json({ error: 'نشانی پخش رادیو با پروتکل امن سایت سازگار نیست.' });
        }
      }
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        for (const [key, value] of Object.entries(updates)) {
          await connection.execute(
            'INSERT INTO settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)',
            [key, value],
          );
        }
        await writeAudit(connection, request.user.id, 'settings.update', 'settings', null, request, { changed_keys: keys });
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
      appEvents.emit('settings.changed');
      return response.json({ ok: true, settings: candidate });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/stats', async (request, response, next) => {
    try {
      const clauses = ['deleted_at IS NULL'];
      const values = [];
      if (request.user.role !== 'super_admin') {
        const regions = await getRegions(pool);
        const allowed = [...adminRegionIds(request.user, regions)];
        if (!allowed.length) return response.json({ counts: { total: 0, draft: 0, scheduled: 0, published: 0, views: 0 }, latest: [], most_viewed: [] });
        clauses.push(`origin_region_id IN (${allowed.map(() => '?').join(', ')})`);
        values.push(...allowed);
      }
      const where = clauses.join(' AND ');
      const [countRows, latest, mostViewed] = await Promise.all([
        pool.execute(
          `SELECT COUNT(*) AS total, SUM(status = 'draft') AS drafts,
                  SUM(status = 'scheduled') AS scheduled, SUM(status = 'published') AS published,
                  COALESCE(SUM(view_count), 0) AS views FROM news WHERE ${where}`,
          values,
        ),
        pool.execute(
          `SELECT id, title, status, published_at, view_count, updated_at FROM news
           WHERE ${where} ORDER BY updated_at DESC, id DESC LIMIT 10`,
          values,
        ),
        pool.execute(
          `SELECT id, title, status, published_at, view_count FROM news
           WHERE ${where} ORDER BY view_count DESC, id DESC LIMIT 10`,
          values,
        ),
      ]);
      const counts = countRows[0][0];
      return response.json({
        counts: {
          total: Number(counts.total), draft: Number(counts.drafts ?? 0),
          scheduled: Number(counts.scheduled ?? 0), published: Number(counts.published ?? 0),
          views: Number(counts.views),
        },
        latest: latest[0], most_viewed: mostViewed[0],
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/users', async (request, response, next) => {
    try {
      const regions = await getRegions(pool);
      const [rows] = await pool.query(
        `SELECT u.id, u.username, u.full_name, u.role, u.region_id, u.created_by, u.is_active,
                u.must_change_password, u.totp_enabled, u.last_login_at, u.created_at,
                r.name AS region_name, r.type AS region_type, r.parent_id AS parent_region_id
         FROM users u JOIN regions r ON r.id = u.region_id ORDER BY r.sort_order, u.role, u.username`,
      );
      const users = request.user.role === 'super_admin'
        ? rows
        : rows.filter((user) => canManageUser(request.user, user, 'view', regions));
      return response.json({ users: users.map(safeUser) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/users', async (request, response, next) => {
    const username = typeof request.body?.username === 'string' ? request.body.username.trim() : '';
    const fullName = cleanFaText(request.body?.full_name);
    const role = request.body?.role;
    const regionId = parseId(request.body?.region_id);
    if (!USERNAME_PATTERN.test(username) || !fullName || fullName.length > 160 || !regionId) {
      return response.status(400).json({ error: 'نام کاربری، نام کامل یا منطقه معتبر نیست.' });
    }
    try {
      const regions = await getRegions(pool);
      const target = regions.find((region) => Number(region.id) === regionId);
      if (!canCreateUser(request.user, role, target, regions)) {
        return response.status(403).json({ error: 'اجازهٔ ساخت کاربر در این نقش یا منطقه را ندارید.' });
      }
      const generatedPassword = temporaryPassword();
      const passwordHash = await hashPassword(generatedPassword);
      const connection = await pool.getConnection();
      let insertedId;
      try {
        await connection.beginTransaction();
        const [lockedRegions] = await connection.execute(
          'SELECT id, parent_id, type, name FROM regions WHERE id = ? FOR UPDATE',
          [regionId],
        );
        const lockedRegion = lockedRegions[0];
        if (!lockedRegion || !canCreateUser(request.user, role, lockedRegion, regions)) {
          await connection.rollback();
          return response.status(403).json({ error: 'منطقهٔ انتخاب‌شده دیگر مجاز نیست.' });
        }
        if (role === 'city_admin') {
          const [settingRows] = await connection.execute('SELECT v FROM settings WHERE k = ?', ['max_city_admins']);
          const configuredLimit = Number.parseInt(settingRows[0]?.v ?? '1', 10);
          const maxAdmins = Number.isSafeInteger(configuredLimit) ? Math.max(1, configuredLimit) : 1;
          const [countRows] = await connection.execute(
            `SELECT COUNT(*) AS active_count FROM users
             WHERE region_id = ? AND role = 'city_admin' AND is_active = 1`,
            [regionId],
          );
          if (Number(countRows[0].active_count) >= maxAdmins) {
            await connection.rollback();
            return response.status(409).json({ error: `برای این مرکز دانشگاهی حداکثر ${maxAdmins} مدیر فعال مجاز است؛ ابتدا مدیر فعلی را غیرفعال کنید.` });
          }
        }
        const [result] = await connection.execute(
          `INSERT INTO users (username, password_hash, full_name, role, region_id, created_by, is_active, must_change_password)
           VALUES (?, ?, ?, ?, ?, ?, 1, 1)`,
          [username, passwordHash, fullName, role, regionId, request.user.id],
        );
        insertedId = result.insertId;
        await writeAudit(connection, request.user.id, 'user.create', 'user', insertedId, request, { role, region_id: regionId });
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        if (error.code === 'ER_DUP_ENTRY') return response.status(409).json({ error: 'این نام کاربری قبلاً ثبت شده است.' });
        throw error;
      } finally {
        connection.release();
      }
      return response.status(201).json({ id: insertedId, username, full_name: fullName, role, region_id: regionId, temporary_password: generatedPassword });
    } catch (error) {
      return next(error);
    }
  });

  router.patch('/users/:id', async (request, response, next) => {
    const id = parseId(request.params.id);
    if (!id) return response.status(400).json({ error: 'شناسهٔ کاربر معتبر نیست.' });
    const keys = Object.keys(request.body ?? {});
    if (keys.some((key) => !['username', 'full_name'].includes(key)) || keys.length === 0) {
      return response.status(400).json({ error: 'فقط نام کاربری و نام کامل قابل ویرایش است.' });
    }
    const username = request.body.username === undefined ? undefined : String(request.body.username).trim();
    const fullName = request.body.full_name === undefined ? undefined : cleanFaText(request.body.full_name);
    if ((username !== undefined && !USERNAME_PATTERN.test(username)) || (fullName !== undefined && (!fullName || fullName.length > 160))) {
      return response.status(400).json({ error: 'نام کاربری یا نام کامل معتبر نیست.' });
    }
    try {
      const regions = await getRegions(pool);
      const isSelf = Number(request.user.id) === id;
      const target = isSelf ? request.user : await loadManagedUser(pool, id, request.user, regions, 'patch');
      if (!target) return response.status(404).json({ error: 'کاربر پیدا نشد یا در محدودهٔ مدیریت شما نیست.' });
      const fields = [];
      const values = [];
      if (username !== undefined) { fields.push('username = ?'); values.push(username); }
      if (fullName !== undefined) { fields.push('full_name = ?'); values.push(fullName); }
      values.push(id);
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        await connection.execute(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values);
        await connection.execute(
          `INSERT INTO audit_log (user_id, action, entity, entity_id, meta, ip)
           VALUES (?, 'user.update', 'user', ?, ?, ?)`,
          [request.user.id, id, JSON.stringify({ fields: keys }), request.ip ?? null],
        );
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
      return response.json({ ok: true });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') return response.status(409).json({ error: 'این نام کاربری قبلاً ثبت شده است.' });
      return next(error);
    }
  });

  for (const action of MANAGE_ROUTES) {
    router.post(`/users/:id/${action}`, async (request, response, next) => {
      const id = parseId(request.params.id);
      if (!id) return response.status(400).json({ error: 'شناسهٔ کاربر معتبر نیست.' });
      try {
        const regions = await getRegions(pool);
        const target = await loadManagedUser(pool, id, request.user, regions, action === 'reset-password' ? 'reset_password' : action === 'reset-2fa' ? 'reset_2fa' : action,);
        if (!target) return response.status(404).json({ error: 'کاربر پیدا نشد یا در محدودهٔ مدیریت شما نیست.' });
        const connection = await pool.getConnection();
        let generatedPassword;
        try {
          await connection.beginTransaction();
          if (action === 'deactivate') {
            await connection.execute('UPDATE users SET is_active = 0 WHERE id = ?', [id]);
            await connection.execute('DELETE FROM sessions WHERE user_id = ?', [id]);
            await connection.execute('DELETE FROM trusted_devices WHERE user_id = ?', [id]);
          } else if (action === 'activate') {
            await connection.execute('UPDATE users SET is_active = 1 WHERE id = ?', [id]);
          } else if (action === 'reset-password') {
            generatedPassword = temporaryPassword();
            const passwordHash = await hashPassword(generatedPassword);
            await connection.execute(
              `UPDATE users SET password_hash = ?, must_change_password = 1, password_changed_at = NULL WHERE id = ?`,
              [passwordHash, id],
            );
            await connection.execute('DELETE FROM sessions WHERE user_id = ?', [id]);
            await connection.execute('DELETE FROM trusted_devices WHERE user_id = ?', [id]);
          } else if (action === 'reset-2fa') {
            await connection.execute(
              `UPDATE users SET totp_secret_enc = NULL, totp_enabled = 0, totp_last_step = NULL WHERE id = ?`,
              [id],
            );
            await connection.execute('DELETE FROM backup_codes WHERE user_id = ?', [id]);
            await connection.execute('DELETE FROM sessions WHERE user_id = ?', [id]);
            await connection.execute('DELETE FROM trusted_devices WHERE user_id = ?', [id]);
          }
          await writeAudit(connection, request.user.id, `user.${action.replace('-', '_')}`, 'user', id, request);
          await connection.commit();
        } catch (error) {
          await connection.rollback();
          throw error;
        } finally {
          connection.release();
        }
        return response.json({ ok: true, ...(generatedPassword ? { temporary_password: generatedPassword } : {}) });
      } catch (error) {
        return next(error);
      }
    });
  }

  router.delete('/users/:id', async (request, response, next) => {
    const id = parseId(request.params.id);
    if (!id) return response.status(400).json({ error: 'شناسهٔ کاربر معتبر نیست.' });
    try {
      const regions = await getRegions(pool);
      const target = await loadManagedUser(pool, id, request.user, regions, 'delete');
      if (!target) return response.status(404).json({ error: 'کاربر پیدا نشد یا اجازهٔ حذف او را ندارید.' });
      const connection = await pool.getConnection();
      let successor;
      let movedNews = 0;
      try {
        await connection.beginTransaction();
        const [lockedRows] = await connection.execute('SELECT id, role, region_id FROM users WHERE id = ? FOR UPDATE', [id]);
        if (!lockedRows[0]) {
          await connection.rollback();
          return response.status(404).json({ error: 'کاربر پیدا نشد.' });
        }
        if (target.role === 'province_admin') {
          const [subordinates] = await connection.execute(
            `SELECT COUNT(*) AS total FROM users u JOIN regions r ON r.id = u.region_id
             WHERE u.role = 'city_admin' AND r.parent_id = ?`,
            [target.region_id],
          );
          if (Number(subordinates[0].total) > 0) {
            await connection.rollback();
            return response.status(409).json({ error: 'این مدیر استان هنوز مدیر زیرمجموعه دارد؛ ابتدا مدیران مراکز دانشگاهی این استان را حذف کنید.' });
          }
        }
        // Superior: a city admin's news go to the active province admin of the same province;
        // otherwise (province admin, or no province admin) to the person performing the deletion.
        successor = { id: request.user.id, full_name: request.user.full_name };
        if (target.role === 'city_admin' && target.parent_region_id) {
          const [superiors] = await connection.execute(
            `SELECT id, full_name FROM users
             WHERE role = 'province_admin' AND region_id = ? AND is_active = 1 AND id <> ?
             ORDER BY id LIMIT 1`,
            [target.parent_region_id, id],
          );
          if (superiors[0]) successor = superiors[0];
        }
        const [moved] = await connection.execute('UPDATE news SET created_by = ? WHERE created_by = ?', [successor.id, id]);
        movedNews = Number(moved.affectedRows);
        await connection.execute('UPDATE news SET updated_by = ? WHERE updated_by = ?', [successor.id, id]);
        await connection.execute('UPDATE news SET published_by_user_id = ? WHERE published_by_user_id = ?', [successor.id, id]);
        await connection.execute('UPDATE users SET created_by = ? WHERE created_by = ?', [successor.id, id]);
        await connection.execute('DELETE FROM users WHERE id = ?', [id]);
        await writeAudit(connection, request.user.id, 'user.delete', 'user', id, request, {
          username: target.username, role: target.role, region_id: target.region_id,
          transferred_to: successor.id, news_transferred: movedNews,
        });
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
      appEvents.emit('news.changed', { id: null });
      return response.json({ ok: true, news_transferred: movedNews, transferred_to: { id: successor.id, full_name: successor.full_name } });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/regions', async (request, response, next) => {
    try {
      const regions = await getRegions(pool);
      const targets = allowedPublishTargets(request.user, regions);
      return response.json({ regions: targets });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/regions/overview', async (request, response, next) => {
    if (!canManageRegion(request.user)) return response.status(403).json({ error: 'فقط مدیر ارشد می‌تواند مراکز و واحدها را مدیریت کند.' });
    try {
      const [rows] = await pool.query(
        `SELECT r.id, r.parent_id, r.type, r.name, r.visibility_override,
                (SELECT COUNT(*) FROM users u WHERE u.region_id = r.id AND u.is_active = 1) AS active_admins,
                (SELECT u.full_name FROM users u WHERE u.region_id = r.id AND u.is_active = 1 ORDER BY u.id LIMIT 1) AS admin_name
         FROM regions r WHERE r.type IN ('province', 'city') ORDER BY r.sort_order, r.id`,
      );
      return response.json({
        units: rows.map((row) => ({ ...row, id: Number(row.id), parent_id: Number(row.parent_id), active_admins: Number(row.active_admins) })),
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/regions', async (request, response, next) => {
    if (!canManageRegion(request.user)) return response.status(403).json({ error: 'فقط مدیر ارشد می‌تواند مناطق را مدیریت کند.' });
    const type = request.body?.type;
    const name = cleanFaText(request.body?.name);
    const parentId = request.body?.parent_id === null ? null : parseId(request.body?.parent_id);
    const code = request.body?.code ? String(request.body.code).trim() : null;
    if (!['province', 'city'].includes(type) || !name || name.length > 160 || (code && code.length > 40)) {
      return response.status(400).json({ error: 'اطلاعات منطقه معتبر نیست.' });
    }
    try {
      const [parents] = await pool.execute('SELECT id, type FROM regions WHERE id = ?', [parentId]);
      const parent = parents[0];
      const validParent = (type === 'province' && parent?.type === 'country') || (type === 'city' && parent?.type === 'province');
      if (!validParent) return response.status(400).json({ error: 'استان باید زیرمجموعهٔ کشور و مرکز دانشگاهی باید زیرمجموعهٔ استان باشد.' });
      const connection = await pool.getConnection();
      let id;
      try {
        await connection.beginTransaction();
        const [result] = await connection.execute(
          `INSERT INTO regions (parent_id, type, name, code, visibility_override)
           VALUES (?, ?, ?, ?, 'auto')`,
          [parentId, type, name, code],
        );
        id = result.insertId;
        await writeAudit(connection, request.user.id, 'region.create', 'region', id, request, { type, parent_id: parentId });
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        if (error.code === 'ER_DUP_ENTRY') return response.status(409).json({ error: 'این کد یا نام منطقه از قبل وجود دارد.' });
        throw error;
      } finally {
        connection.release();
      }
      appEvents.emit('regions.changed');
      return response.status(201).json({ id, type, name, parent_id: parentId, code });
    } catch (error) {
      return next(error);
    }
  });

  router.patch('/regions/:id', async (request, response, next) => {
    if (!canManageRegion(request.user)) return response.status(403).json({ error: 'فقط مدیر ارشد می‌تواند مناطق را مدیریت کند.' });
    const id = parseId(request.params.id);
    if (!id) return response.status(400).json({ error: 'شناسهٔ منطقه معتبر نیست.' });
    const keys = Object.keys(request.body ?? {});
    if (!keys.length || keys.some((key) => !['name', 'visibility_override'].includes(key))) {
      return response.status(400).json({ error: 'فقط نام و وضعیت نمایش منطقه قابل ویرایش است.' });
    }
    const name = request.body.name === undefined ? undefined : cleanFaText(request.body.name);
    const visibility = request.body.visibility_override;
    if ((name !== undefined && (!name || name.length > 160)) || (visibility !== undefined && !VISIBILITY_VALUES.has(visibility))) {
      return response.status(400).json({ error: 'نام یا وضعیت نمایش معتبر نیست.' });
    }
    try {
      const fields = [];
      const values = [];
      if (name !== undefined) { fields.push('name = ?'); values.push(name); }
      if (visibility !== undefined) { fields.push('visibility_override = ?'); values.push(visibility); }
      values.push(id);
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [existing] = await connection.execute('SELECT id FROM regions WHERE id = ? FOR UPDATE', [id]);
        if (!existing.length) {
          await connection.rollback();
          return response.status(404).json({ error: 'منطقه پیدا نشد.' });
        }
        await connection.execute(`UPDATE regions SET ${fields.join(', ')} WHERE id = ?`, values);
        await writeAudit(connection, request.user.id, 'region.update', 'region', id, request, { fields: keys });
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
      appEvents.emit('regions.changed');
      return response.json({ ok: true });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') return response.status(409).json({ error: 'نام منطقه در این شاخه تکراری است.' });
      return next(error);
    }
  });

  router.get('/audit', async (request, response, next) => {
    try {
      const cursor = request.query.before ? parseId(request.query.before) : null;
      if (request.query.before && !cursor) return response.status(400).json({ error: 'نشانگر صفحه معتبر نیست.' });
      const limitValue = Number(request.query.limit ?? 50);
      const limit = Number.isInteger(limitValue) ? Math.max(1, Math.min(100, limitValue)) : 50;
      const clauses = [];
      const values = [];
      if (request.user.role !== 'super_admin') {
        const regions = await getRegions(pool);
        const allowed = adminRegionIds(request.user, regions);
        const scope = regions.filter((region) => allowed.has(Number(region.id)) && region.type !== 'country').map((region) => Number(region.id));
        const placeholders = scope.map(() => '?').join(', ');
        clauses.push(`(actor.region_id IN (${placeholders}) OR target.region_id IN (${placeholders}))`);
        values.push(...scope, ...scope);
      }
      if (cursor) {
        clauses.push('a.id < ?');
        values.push(cursor);
      }
      values.push(limit);
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const [items] = await pool.execute(
        `SELECT a.id, a.user_id, a.action, a.entity, a.entity_id, a.meta, a.ip, a.created_at,
                actor.username AS actor_username, target.username AS target_username
         FROM audit_log a
         LEFT JOIN users actor ON actor.id = a.user_id
         LEFT JOIN users target ON a.entity = 'user' AND target.id = a.entity_id
         ${where}
         ORDER BY a.id DESC LIMIT ?`,
        values,
      );
      return response.json({ items, next_cursor: items.length === limit ? String(items.at(-1).id) : null });
    } catch (error) {
      return next(error);
    }
  });

  router.use((error, request, response, next) => {
    console.error(`Admin request failed: ${error.message}`);
    if (response.headersSent) return next(error);
    return response.status(500).json({ error: 'خطای داخلی رخ داد.' });
  });

  return router;
}
