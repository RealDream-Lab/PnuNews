import { describeNowPlayingError, fetchNowPlaying, makeRadioResolver, resolveNowPlayingUrl } from '../lib/nowplaying.js';
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { hashPassword } from '../auth/crypto.js';
import { canCreateUser, canManageRegion, canManageUser, allowedPublishTargets, newsVisibilitySql, auditRegionIds, isUnitAdmin, unitsInScope } from '../auth/policy.js';
import { createAuthMiddleware, requirePasswordChanged } from './auth.js';
import { cleanFaText, usernameKey } from '../lib/fa.js';
import { isObviouslyInternalHost } from '../lib/net-guard.js';
import { appEvents } from '../events.js';
import { compareUsersForTree, groupUsersForTree } from '../lib/user-tree.js';
import { createNewsAdminRouter } from './news-admin.js';
import { createAttachmentDeleteRouter } from './news-attachments.js';
import { createCategoryAdminRouter } from './categories-admin.js';
import { createDomainAdminRouter } from './domains-admin.js';
import { createReaderAdminRouter } from './readers-admin.js';

const USERNAME_PATTERN = /^[\p{L}\p{N}_.-]{3,80}$/u;
const VISIBILITY_VALUES = new Set(['auto', 'show', 'hide']);
const MANAGE_ROUTES = new Set(['deactivate', 'activate', 'reset-password', 'reset-2fa']);
const ADMIN_SETTING_KEYS = new Set([
  'radio_enabled', 'radio_title', 'radio_stream_url', 'radio_nowplaying_url',
  'byline_show_person', 'site_title',
]);
const UNIT_ADMIN_ROLES = ['country_admin', 'province_admin', 'city_admin'];

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
    domain_id: user.domain_id ?? null,
    domain_name: user.domain_name ?? null,
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
    `SELECT u.id, u.username, u.full_name, u.role, u.region_id, u.domain_id, u.created_by, u.is_active,
            u.must_change_password, u.totp_enabled, u.last_login_at, u.created_at,
            r.name AS region_name, r.type AS region_type, r.parent_id AS parent_region_id,
            d.name AS domain_name
     FROM users u JOIN regions r ON r.id = u.region_id
     LEFT JOIN work_domains d ON d.id = u.domain_id WHERE u.id = ? LIMIT 1`,
    [targetId],
  );
  const target = rows[0];
  return target && canManageUser(actor, target, action, regions) ? target : null;
}

function parseId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// One active admin per unit, and one active user per work domain per unit. `target.id` is 0 for a user not created yet.
async function activeConflict(connection, target) {
  if (target.role === 'domain_user') {
    const [rows] = await connection.execute(
      `SELECT COUNT(*) AS total FROM users
       WHERE role = 'domain_user' AND region_id = ? AND domain_id = ? AND is_active = 1 AND id <> ?`,
      [target.region_id, target.domain_id, target.id],
    );
    return Number(rows[0].total) > 0
      ? 'برای این حوزه در این واحد قبلاً کاربر فعال ثبت شده است؛ ابتدا کاربر فعلی را غیرفعال کنید.'
      : null;
  }
  if (UNIT_ADMIN_ROLES.includes(target.role)) {
    const [rows] = await connection.execute(
      `SELECT COUNT(*) AS total FROM users
       WHERE role IN ('country_admin', 'province_admin', 'city_admin') AND region_id = ?
         AND is_active = 1 AND is_system = 0 AND id <> ?`,
      [target.region_id, target.id],
    );
    return Number(rows[0].total) > 0
      ? 'برای این واحد قبلاً مدیر فعال ثبت شده است؛ ابتدا مدیر فعلی را غیرفعال کنید.'
      : null;
  }
  return null;
}

// Files on disk that belong to one attachment row: images are stored as three webp sizes, other files as one blob.
function attachmentFilePaths(root, row) {
  const name = path.basename(String(row.stored_name ?? ''));
  if (!name) return [];
  return row.kind === 'file'
    ? [path.join(root, name)]
    : [400, 800, 1280].map((width) => path.join(root, `${name}-${width}.webp`));
}

// Usernames are unique across the whole country (every province, centre and role). The database key catches exact
// duplicates; this also refuses names that only differ by case, Arabic/Persian letter forms, digits or half-spaces.
// A named lock serialises the check with the write so two admins cannot take the same name at the same moment.
const USERNAME_LOCK = 'pnunews-usernames';

async function lockUsernames(connection) {
  const [rows] = await connection.query('SELECT GET_LOCK(?, 5) AS got', [USERNAME_LOCK]);
  return Number(rows[0]?.got) === 1;
}

async function unlockUsernames(connection) {
  try { await connection.query('SELECT RELEASE_LOCK(?)', [USERNAME_LOCK]); } catch { /* connection already gone */ }
}

async function usernameTaken(connection, username, exceptId) {
  const key = usernameKey(username);
  const [rows] = await connection.query('SELECT username FROM users WHERE id <> ?', [exceptId]);
  return rows.some((row) => usernameKey(row.username) === key);
}

const USERNAME_TAKEN = 'این نام کاربری قبلاً در سیستم ثبت شده است؛ نام کاربری باید در کل کشور یکتا باشد.';
const USERNAME_BUSY = 'سامانه مشغول بررسی نام‌های کاربری است؛ چند لحظه بعد دوباره تلاش کنید.';

function writeAudit(connection, actorId, action, entity, entityId, request, meta = null) {
  return connection.execute(
    `INSERT INTO audit_log (user_id, action, entity, entity_id, meta, ip)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [actorId, action, entity, entityId, meta ? JSON.stringify(meta) : null, request.ip ?? null],
  );
}

export function createAdminRouter({ pool, config, clock = Date.now, uploadRoot, portalImporter = null, fetchImpl = fetch, smsBudget = null }) {
  const router = express.Router();
  router.use(createAuthMiddleware(pool, config), requirePasswordChanged);
  router.use('/news', createNewsAdminRouter({ pool, clock, uploadRoot }));
  router.use('/attachments', createAttachmentDeleteRouter({ pool, uploadRoot }));
  router.use('/categories', createCategoryAdminRouter({ pool }));
  router.use('/domains', createDomainAdminRouter({ pool }));
  router.use('/readers', createReaderAdminRouter({ pool, smsBudget }));

  // internal = the app's own timer (every 3 minutes); external = an OS scheduler runs scripts/fetch-portal-news.sh
  const portalMode = () => (process.env.PORTAL_FETCH_MODE === 'external' ? 'external' : 'internal');

  // Automatic portal news: status, on/off switch and "fetch now" (main admin only).
  router.get('/portal-news', async (request, response, next) => {
    if (request.user.role !== 'super_admin') return response.status(403).json({ error: 'فقط مدیر ارشد به خبرخوان پورتال دسترسی دارد.' });
    if (!portalImporter) return response.status(503).json({ error: 'خبرخوان پورتال در این اجرا فعال نیست.' });
    try { return response.json({ ...(await portalImporter.status()), mode: portalMode() }); } catch (error) { return next(error); }
  });
  router.post('/portal-news', async (request, response, next) => {
    if (request.user.role !== 'super_admin') return response.status(403).json({ error: 'فقط مدیر ارشد به خبرخوان پورتال دسترسی دارد.' });
    if (!portalImporter) return response.status(503).json({ error: 'خبرخوان پورتال در این اجرا فعال نیست.' });
    try {
      if (typeof request.body?.enabled === 'boolean') await portalImporter.setEnabled(request.body.enabled);
      const result = request.body?.run === true ? await portalImporter.runOnce({ force: true }) : null;
      return response.json({ ...(await portalImporter.status()), mode: portalMode(), result });
    } catch (error) { return next(error); }
  });

  // Tries the radio "now playing" address from this server and says exactly why it fails (main admin only).
  router.post('/radio/nowplaying-test', async (request, response, next) => {
    if (!canManageRegion(request.user)) return response.status(403).json({ error: 'فقط مدیر ارشد می‌تواند رادیو را آزمایش کند.' });
    try {
      const [rows] = await pool.query("SELECT k, v FROM settings WHERE k IN ('radio_nowplaying_url', 'radio_stream_url')");
      const saved = Object.fromEntries(rows.map((row) => [row.k, row.v]));
      const pick = (key) => (typeof request.body?.[key] === 'string' ? request.body[key].trim() : String(saved[key] ?? ''));
      const streamUrl = pick('stream_url');
      let url;
      try { url = resolveNowPlayingUrl({ nowPlayingUrl: pick('url'), streamUrl }); } catch { url = null; }
      if (!url) return response.json({ ok: false, error: 'نشانی اکنون‌پخش (یا دست‌کم نشانی پخش) معتبر وارد نشده است.' });
      try {
        const nowPlaying = await fetchNowPlaying(url, { fetchImpl, publicUrl: config.publicUrl, streamUrl, resolvesPublic: makeRadioResolver(config.radioTrustedHosts) });
        return response.json({ ok: true, now_playing: nowPlaying, url: url.href });
      } catch (error) {
        return response.json({ ok: false, code: error.code ?? 'unknown', url: url.href, error: describeNowPlayingError(error) });
      }
    } catch (error) { return next(error); }
  });

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
        if (['radio_enabled', 'byline_show_person'].includes(key)) {
          const normalized = value === true ? '1' : value === false ? '0' : String(value);
          if (!['0', '1'].includes(normalized)) return response.status(400).json({ error: `مقدار تنظیم «${key}» باید روشن یا خاموش باشد.` });
          updates[key] = normalized;
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
            if (key === 'radio_nowplaying_url' && isObviouslyInternalHost(url.hostname)) {
              return response.status(400).json({ error: 'نشانی «در حال پخش» نمی‌تواند به شبکهٔ داخلی یا localhost اشاره کند.' });
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
      const clauses = ['n.deleted_at IS NULL'];
      const values = [];
      const regions = await getRegions(pool);
      const visibility = newsVisibilitySql(request.user, regions);
      if (visibility) {
        clauses.push(visibility.sql);
        values.push(...visibility.values);
      }
      const where = clauses.join(' AND ');
      const [countRows, latest, mostViewed] = await Promise.all([
        pool.execute(
          `SELECT COUNT(*) AS total, SUM(n.status = 'draft') AS drafts,
                  SUM(n.status = 'scheduled') AS scheduled, SUM(n.status = 'published') AS published,
                  COALESCE(SUM(n.view_count), 0) AS views FROM news n JOIN users creator ON creator.id = n.created_by WHERE ${where}`,
          values,
        ),
        pool.execute(
          `SELECT n.id, n.title, n.status, n.published_at, n.view_count, n.updated_at, n.source_url
           FROM news n JOIN users creator ON creator.id = n.created_by
           WHERE ${where} ORDER BY n.updated_at DESC, n.id DESC LIMIT 10`,
          values,
        ),
        pool.execute(
          `SELECT n.id, n.title, n.status, n.published_at, n.view_count, n.source_url
           FROM news n JOIN users creator ON creator.id = n.created_by
           WHERE ${where} ORDER BY n.view_count DESC, n.id DESC LIMIT 10`,
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
        `SELECT u.id, u.username, u.full_name, u.role, u.region_id, u.domain_id, u.created_by, u.is_active,
                u.must_change_password, u.totp_enabled, u.last_login_at, u.created_at,
                r.name AS region_name, r.type AS region_type, r.parent_id AS parent_region_id,
                r.sort_order AS region_sort, p.sort_order AS parent_sort, d.sort_order AS domain_sort,
                d.name AS domain_name
         FROM users u JOIN regions r ON r.id = u.region_id
         LEFT JOIN regions p ON p.id = r.parent_id
         LEFT JOIN work_domains d ON d.id = u.domain_id
         WHERE u.is_system = 0`,
      );
      const users = (request.user.role === 'super_admin'
        ? rows
        : rows.filter((user) => canManageUser(request.user, user, 'view', regions))).sort(compareUsersForTree);
      const mapped = users.map((user) => ({
        ...safeUser(user),
        // shown in the delete confirmation: how many city users sit under a province admin
        subordinate_count: user.role === 'province_admin'
          ? users.filter((item) => item.role === 'city_admin' && Number(item.parent_region_id) === Number(user.region_id)).length
          : 0,
      }));
      if (request.query.page === undefined) return response.json({ users: mapped });
      // Numbered pages (`page=N&limit=M`); without `page` the full list is returned for the forms that need it.
      const requestedPage = Number(request.query.page);
      if (!Number.isSafeInteger(requestedPage) || requestedPage < 1 || requestedPage > 100_000) {
        return response.status(400).json({ error: 'شمارهٔ صفحه معتبر نیست.' });
      }
      const requestedLimit = Number(request.query.limit ?? 15);
      const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(100, requestedLimit)) : 15;
      // صفحه‌بندی در مرز گروه‌ها (کشور، هر استان با مراکزش) است تا مراکز هیچ‌وقت از استان خود جدا نشوند؛
      // گروهی که خودش از `limit` بزرگ‌تر باشد تنها در یک صفحه می‌آید.
      const pagesOfUsers = [];
      let current = [];
      for (const group of groupUsersForTree(mapped)) {
        if (current.length && current.length + group.length > limit) {
          pagesOfUsers.push(current);
          current = [];
        }
        current.push(...group);
      }
      if (current.length) pagesOfUsers.push(current);
      const pages = Math.max(1, pagesOfUsers.length);
      const page = Math.min(requestedPage, pages);
      return response.json({ users: pagesOfUsers[page - 1] ?? [], page, pages, total: mapped.length, limit });
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
    const domainId = role === 'domain_user' ? parseId(request.body?.domain_id) : null;
    if (role === 'domain_user' && !domainId) return response.status(400).json({ error: 'حوزهٔ کاربر را انتخاب کنید.' });
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
        if (role === 'domain_user') {
          const [domains] = await connection.execute('SELECT id FROM work_domains WHERE id = ? AND is_active = 1', [domainId]);
          if (!domains.length) {
            await connection.rollback();
            return response.status(400).json({ error: 'حوزهٔ انتخاب‌شده پیدا نشد یا غیرفعال است.' });
          }
        }
        const conflict = await activeConflict(connection, { id: 0, role, region_id: regionId, domain_id: domainId });
        if (conflict) {
          await connection.rollback();
          return response.status(409).json({ error: conflict });
        }
        if (!(await lockUsernames(connection))) {
          await connection.rollback();
          return response.status(503).json({ error: USERNAME_BUSY });
        }
        if (await usernameTaken(connection, username, 0)) {
          await connection.rollback();
          return response.status(409).json({ error: USERNAME_TAKEN });
        }
        const [result] = await connection.execute(
          `INSERT INTO users (username, password_hash, full_name, role, region_id, domain_id, created_by, is_active, must_change_password)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)`,
          [username, passwordHash, fullName, role, regionId, domainId, request.user.id],
        );
        insertedId = result.insertId;
        await writeAudit(connection, request.user.id, 'user.create', 'user', insertedId, request, { role, region_id: regionId, ...(domainId ? { domain_id: domainId } : {}) });
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        if (error.code === 'ER_DUP_ENTRY') return response.status(409).json({ error: USERNAME_TAKEN });
        throw error;
      } finally {
        await unlockUsernames(connection);
        connection.release();
      }
      return response.status(201).json({ id: insertedId, username, full_name: fullName, role, region_id: regionId, domain_id: domainId, temporary_password: generatedPassword });
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
        const renamed = username !== undefined && username !== target.username;
        if (renamed) {
          if (!(await lockUsernames(connection))) {
            await connection.rollback();
            return response.status(503).json({ error: USERNAME_BUSY });
          }
          if (await usernameTaken(connection, username, id)) {
            await connection.rollback();
            return response.status(409).json({ error: USERNAME_TAKEN });
          }
        }
        await connection.execute(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values);
        await connection.execute(
          `INSERT INTO audit_log (user_id, action, entity, entity_id, meta, ip)
           VALUES (?, 'user.update', 'user', ?, ?, ?)`,
          [request.user.id, id, JSON.stringify({ fields: keys, ...(renamed ? { username_from: target.username, username_to: username } : {}) }), request.ip ?? null],
        );
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        await unlockUsernames(connection);
        connection.release();
      }
      return response.json({ ok: true });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') return response.status(409).json({ error: USERNAME_TAKEN });
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
        // Activation may carry a new username: both changes happen in one transaction or neither does.
        const newUsername = action === 'activate' && request.body?.username !== undefined ? String(request.body.username).trim() : undefined;
        if (newUsername !== undefined && !USERNAME_PATTERN.test(newUsername)) {
          return response.status(400).json({ error: 'نام کاربری معتبر نیست.', field: 'username' });
        }
        const connection = await pool.getConnection();
        let generatedPassword;
        try {
          await connection.beginTransaction();
          if (action === 'deactivate') {
            await connection.execute('UPDATE users SET is_active = 0 WHERE id = ?', [id]);
            await connection.execute('DELETE FROM sessions WHERE user_id = ?', [id]);
          } else if (action === 'activate') {
            await connection.execute('SELECT id FROM regions WHERE id = ? FOR UPDATE', [target.region_id]);
            const conflict = await activeConflict(connection, target);
            if (conflict) {
              await connection.rollback();
              return response.status(409).json({ error: conflict });
            }
            const renamed = newUsername !== undefined && newUsername !== target.username;
            if (renamed) {
              if (!(await lockUsernames(connection))) {
                await connection.rollback();
                return response.status(503).json({ error: USERNAME_BUSY, field: 'username' });
              }
              if (await usernameTaken(connection, newUsername, id)) {
                await connection.rollback();
                return response.status(409).json({ error: USERNAME_TAKEN, field: 'username' });
              }
              await connection.execute('UPDATE users SET is_active = 1, username = ? WHERE id = ?', [newUsername, id]);
              await connection.execute(
                `INSERT INTO audit_log (user_id, action, entity, entity_id, meta, ip)
                 VALUES (?, 'user.update', 'user', ?, ?, ?)`,
                [request.user.id, id, JSON.stringify({ fields: ['username'], username_from: target.username, username_to: newUsername }), request.ip ?? null],
              );
            } else {
              await connection.execute('UPDATE users SET is_active = 1 WHERE id = ?', [id]);
            }
          } else if (action === 'reset-password') {
            generatedPassword = temporaryPassword();
            const passwordHash = await hashPassword(generatedPassword);
            await connection.execute(
              `UPDATE users SET password_hash = ?, must_change_password = 1, password_changed_at = NULL WHERE id = ?`,
              [passwordHash, id],
            );
            await connection.execute('DELETE FROM sessions WHERE user_id = ?', [id]);
          } else if (action === 'reset-2fa') {
            await connection.execute(
              `UPDATE users SET totp_secret_enc = NULL, totp_enabled = 0, totp_last_step = NULL WHERE id = ?`,
              [id],
            );
            await connection.execute('DELETE FROM backup_codes WHERE user_id = ?', [id]);
            await connection.execute('DELETE FROM sessions WHERE user_id = ?', [id]);
          }
          await writeAudit(connection, request.user.id, `user.${action.replace('-', '_')}`, 'user', id, request);
          await connection.commit();
        } catch (error) {
          await connection.rollback();
          throw error;
        } finally {
          await unlockUsernames(connection);
          connection.release();
        }
        return response.json({ ok: true, ...(generatedPassword ? { temporary_password: generatedPassword } : {}) });
      } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') return response.status(409).json({ error: USERNAME_TAKEN, field: 'username' });
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
        // A domain user's news stay with the unit: they go to its active admin (otherwise to the person deleting).
        if (target.role === 'domain_user') {
          const [supervisors] = await connection.execute(
            `SELECT id, full_name FROM users
             WHERE role IN ('country_admin', 'province_admin', 'city_admin') AND region_id = ?
               AND is_active = 1 AND is_system = 0 AND id <> ?
             ORDER BY id LIMIT 1`,
            [target.region_id, id],
          );
          if (supervisors[0]) successor = supervisors[0];
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

  // «ساختار و کاربران»: the units each admin sees (see `unitsInScope`) with what the page needs to draw them. Everyone
  // with a unit gets the read-only structure; the counts used by the delete confirmation are for the main admin only.
  router.get('/regions/overview', async (request, response, next) => {
    if (!canManageRegion(request.user) && !isUnitAdmin(request.user)) {
      return response.status(403).json({ error: 'این بخش برای کاربران حوزه در دسترس نیست.' });
    }
    try {
      const [rows] = await pool.query(
        `SELECT r.id, r.parent_id, r.type, r.name, r.visibility_override,
                (SELECT COUNT(*) FROM users u WHERE u.region_id = r.id AND u.is_active = 1 AND u.is_system = 0
                   AND u.role IN ('country_admin', 'province_admin', 'city_admin')) AS active_admins,
                (SELECT COUNT(*) FROM users u WHERE u.region_id = r.id AND u.is_system = 0
                   AND u.role IN ('country_admin', 'province_admin', 'city_admin')) AS admins_total,
                (SELECT COUNT(*) FROM regions c WHERE c.parent_id = r.id AND c.type = 'city') AS cities_total,
                (SELECT COUNT(*) FROM regions c WHERE c.parent_id = r.id AND c.type = 'city' AND c.visibility_override <> 'hide'
                   AND (c.visibility_override = 'show' OR EXISTS (
                     SELECT 1 FROM users u WHERE u.region_id = c.id AND u.is_active = 1 AND u.is_system = 0
                       AND u.role IN ('country_admin', 'province_admin', 'city_admin')))) AS active_cities,
                (SELECT COUNT(*) FROM users u WHERE u.region_id = r.id) AS users_total,
                (SELECT COUNT(*) FROM news n WHERE n.origin_region_id = r.id) AS news_total
         FROM regions r WHERE r.type IN ('country', 'province', 'city') ORDER BY r.sort_order, r.id`,
      );
      const isSuper = canManageRegion(request.user);
      const visible = new Set(unitsInScope(request.user, rows).map((unit) => Number(unit.id)));
      return response.json({
        units: rows.filter((row) => visible.has(Number(row.id))).map((row) => {
          const unit = {
            id: Number(row.id), parent_id: row.parent_id === null ? null : Number(row.parent_id), type: row.type, name: row.name,
            visibility_override: row.visibility_override, active_admins: Number(row.active_admins), admins_total: Number(row.admins_total),
            cities_total: Number(row.cities_total), active_cities: Number(row.active_cities),
          };
          return isSuper ? { ...unit, users_total: Number(row.users_total), news_total: Number(row.news_total) } : unit;
        }),
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

  // Permanently delete a university centre with everything that belongs to it: its users, the news it published
  // (and their attachments, also on disk) and its place in other news' targets. Main admin only; cities only.
  router.delete('/regions/:id', async (request, response, next) => {
    if (!canManageRegion(request.user)) return response.status(403).json({ error: 'فقط مدیر ارشد می‌تواند مرکز دانشگاهی را حذف کند.' });
    const id = parseId(request.params.id);
    if (!id) return response.status(400).json({ error: 'شناسهٔ مرکز معتبر نیست.' });
    try {
      const connection = await pool.getConnection();
      let region;
      let removedFiles = [];
      let usersDeleted = 0;
      let newsDeleted = 0;
      try {
        await connection.beginTransaction();
        const [regionRows] = await connection.execute('SELECT id, parent_id, type, name FROM regions WHERE id = ? FOR UPDATE', [id]);
        region = regionRows[0];
        if (!region) {
          await connection.rollback();
          return response.status(404).json({ error: 'مرکز دانشگاهی پیدا نشد.' });
        }
        if (region.type !== 'city') {
          await connection.rollback();
          return response.status(400).json({ error: 'فقط مرکز دانشگاهی قابل حذف است؛ استان و کشور حذف نمی‌شوند.' });
        }
        const [children] = await connection.execute('SELECT COUNT(*) AS total FROM regions WHERE parent_id = ?', [id]);
        if (Number(children[0].total) > 0) {
          await connection.rollback();
          return response.status(409).json({ error: 'این مرکز زیرمجموعه دارد و حذف نمی‌شود.' });
        }
        const [users] = await connection.execute('SELECT id, role, is_system FROM users WHERE region_id = ? FOR UPDATE', [id]);
        if (users.some((user) => user.role === 'super_admin' || Number(user.is_system) === 1)) {
          await connection.rollback();
          return response.status(409).json({ error: 'کاربر سیستمی یا مدیر ارشد به این مرکز وابسته است و حذف انجام نشد.' });
        }
        const userIds = users.map((user) => Number(user.id));

        // Files first (the rows are gone after the delete); removed from disk only after the commit.
        const [attachmentRows] = await connection.execute(
          `SELECT a.stored_name, a.kind FROM attachments a JOIN news n ON n.id = a.news_id WHERE n.origin_region_id = ?`,
          [id],
        );
        removedFiles = attachmentRows;
        // Attachments and news_targets of these news go with them (ON DELETE CASCADE).
        const [deletedNews] = await connection.execute('DELETE FROM news WHERE origin_region_id = ?', [id]);
        newsDeleted = Number(deletedNews.affectedRows);
        await connection.execute('DELETE FROM news_targets WHERE region_id = ?', [id]);

        if (userIds.length) {
          const marks = userIds.map(() => '?').join(', ');
          // News of other units that one of these users wrote or touched stay and pass to the main admin doing the delete.
          await connection.execute(`UPDATE news SET created_by = ? WHERE created_by IN (${marks})`, [request.user.id, ...userIds]);
          await connection.execute(`UPDATE news SET updated_by = ? WHERE updated_by IN (${marks})`, [request.user.id, ...userIds]);
          await connection.execute(`UPDATE news SET published_by_user_id = ? WHERE published_by_user_id IN (${marks})`, [request.user.id, ...userIds]);
          const [deletedUsers] = await connection.execute('DELETE FROM users WHERE region_id = ?', [id]);
          usersDeleted = Number(deletedUsers.affectedRows);
        }
        await connection.execute('DELETE FROM regions WHERE id = ?', [id]);
        await writeAudit(connection, request.user.id, 'region.delete', 'region', id, request, {
          name: region.name, type: region.type, parent_id: region.parent_id, users_deleted: usersDeleted, news_deleted: newsDeleted,
        });
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
      if (uploadRoot) {
        const root = path.resolve(uploadRoot);
        const paths = removedFiles.flatMap((row) => attachmentFilePaths(root, row));
        await Promise.allSettled(paths.map((filePath) => rm(filePath, { force: true })));
      }
      appEvents.emit('regions.changed');
      appEvents.emit('news.changed', { id: null });
      return response.json({ ok: true, users_deleted: usersDeleted, news_deleted: newsDeleted });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/audit', async (request, response, next) => {
    if (request.user.role === 'domain_user') return response.status(403).json({ error: 'گزارش رویدادها برای کاربران حوزه در دسترس نیست.' });
    try {
      const paged = request.query.page !== undefined;
      const requestedPage = Number(request.query.page);
      if (paged && (!Number.isSafeInteger(requestedPage) || requestedPage < 1 || requestedPage > 100_000)) {
        return response.status(400).json({ error: 'شمارهٔ صفحه معتبر نیست.' });
      }
      const cursor = !paged && request.query.before ? parseId(request.query.before) : null;
      if (!paged && request.query.before && !cursor) return response.status(400).json({ error: 'نشانگر صفحه معتبر نیست.' });
      const limitValue = Number(request.query.limit ?? 50);
      const limit = Number.isInteger(limitValue) ? Math.max(1, Math.min(100, limitValue)) : 50;
      const clauses = [];
      const values = [];
      if (request.user.role !== 'super_admin') {
        const regions = await getRegions(pool);
        const scope = [...auditRegionIds(request.user, regions)];
        const placeholders = scope.map(() => '?').join(', ');
        clauses.push(`(actor.region_id IN (${placeholders}) OR target.region_id IN (${placeholders}))`);
        values.push(...scope, ...scope);
      }
      if (cursor) {
        clauses.push('a.id < ?');
        values.push(cursor);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      let total = null;
      let pages = null;
      let page = null;
      if (paged) {
        const [countRows] = await pool.execute(
          `SELECT COUNT(*) AS total FROM audit_log a
           LEFT JOIN users actor ON actor.id = a.user_id
           LEFT JOIN users target ON a.entity = 'user' AND target.id = a.entity_id
           ${where}`,
          values,
        );
        total = Number(countRows[0].total);
        pages = Math.max(1, Math.ceil(total / limit));
        page = Math.min(requestedPage, pages);
      }
      values.push(limit);
      const [items] = await pool.execute(
        `SELECT a.id, a.user_id, a.action, a.entity, a.entity_id, a.meta, a.ip, a.created_at,
                actor.username AS actor_username, target.username AS target_username
         FROM audit_log a
         LEFT JOIN users actor ON actor.id = a.user_id
         LEFT JOIN users target ON a.entity = 'user' AND target.id = a.entity_id
         ${where}
         ORDER BY a.id DESC LIMIT ?${paged ? ` OFFSET ${(page - 1) * limit}` : ''}`,
        values,
      );
      if (paged) return response.json({ items, page, pages, total, limit });
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
