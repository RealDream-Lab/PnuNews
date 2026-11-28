import express from 'express';
import { canManageRegion } from '../auth/policy.js';
import { appEvents } from '../events.js';
import { cleanFaText } from '../lib/fa.js';
import { cleanPersonName, cleanStudentNumber, normalizeDigits } from '../lib/reader-auth.js';
import { INBOUND_KEY_SETTING, loadInboundKey, loadReaderSettings, readerSettingKey, storedValue, validateReaderSettingsUpdate } from '../lib/reader-settings.js';
import { generateInboundKey, webhookUrl } from '../lib/reader-inbound.js';
import { SIGNUP_DISABLED_INFO_KEY } from '../lib/sms-budget.js';

const USERS_PAGE_SIZE = 25;
const USERS_PAGE_SIZE_MAX = 100;
const escapeLike = (text) => text.replace(/[\\%_]/g, '\\$&');

// What the main admin typed in the search box: up to four words, every one of which must be found in the first name, the last
// name, the student number or the phone number («علی رضایی»: first and last name; «0912», «۹۱۲۳۴»: a part of the number). Digits may be
// Persian. The % and _ of a LIKE are escaped, so they are only ever characters to look for.
function searchClause(rawQuery) {
  const text = cleanFaText(normalizeDigits(typeof rawQuery === 'string' ? rawQuery : '')).slice(0, 80);
  const clauses = [];
  const values = [];
  for (const token of text.split(' ').filter(Boolean).slice(0, 4)) {
    const like = `%${escapeLike(token)}%`;
    const parts = ['u.first_name LIKE ?', 'u.last_name LIKE ?', 'u.student_no LIKE ?'];
    const params = [like, like, like];
    // The number is stored as +98912...: typed as 0912... or 912..., only the digits after the leading zero are looked for.
    // Only a word made of digits (and maybe a +) is a phone number; «100%» or «ab12» is not.
    const digits = /^\+?\d+$/.test(token) ? token.replace(/\D/g, '').replace(/^0+/, '') : '';
    if (digits.length >= 3) {
      parts.push('u.phone LIKE ?');
      params.push(`%${digits}%`);
    }
    clauses.push(`(${parts.join(' OR ')})`);
    values.push(...params);
  }
  // Dashboard users have a linked reader account (for their bookmarks); it is not a reader and is never listed or counted.
  return { where: `WHERE u.staff_user_id IS NULL${clauses.length ? ` AND ${clauses.join(' AND ')}` : ''}`, values };
}

function writeAudit(connection, actorId, action, request, meta) {
  return connection.execute(
    `INSERT INTO audit_log (user_id, action, entity, entity_id, meta, ip)
     VALUES (?, ?, 'reader_settings', NULL, ?, ?)`,
    [actorId, action, JSON.stringify(meta), request.ip ?? null],
  );
}

// Reader accounts and the SMS budget belong to the main admin alone. The caller mounts this behind the admin
// authentication, which sets request.user.
export function createReaderAdminRouter({ pool, config = null, events = appEvents, smsBudget = null }) {
  const router = express.Router();

  router.use((request, response, next) => {
    if (canManageRegion(request.user)) return next();
    return response.status(403).json({ error: 'فقط مدیر ارشد به بخش حساب خوانندگان دسترسی دارد.' });
  });

  router.get('/settings', async (request, response, next) => {
    try {
      return response.json({ settings: await loadReaderSettings(pool) });
    } catch (error) {
      return next(error);
    }
  });

  // The SMS budget: credit, estimate of the SMS left, the last 24 hours, recent failures and why signup was switched off.
  // ?refresh=1 reads the credit from ippanel now instead of using the last reading (at most 5 minutes old).
  router.get('/sms-status', async (request, response, next) => {
    if (!smsBudget) return response.status(503).json({ error: 'سرویس پیامک در این اجرا فعال نیست.' });
    try {
      return response.json({ status: await smsBudget.status({ force: request.query.refresh === '1' }) });
    } catch (error) {
      return next(error);
    }
  });

  // The reader accounts, newest first, with a search box (see searchClause) and pages. Editing and deleting an account are the
  // two routes below (PATCH and DELETE /users/:id), main admin only like everything in this router.
  router.get('/users', async (request, response, next) => {
    const pageValue = request.query.page === undefined ? 1 : Number(request.query.page);
    if (!Number.isSafeInteger(pageValue) || pageValue < 1 || pageValue > 100_000) return response.status(400).json({ error: 'شمارهٔ صفحه معتبر نیست.' });
    const limitValue = request.query.limit === undefined ? USERS_PAGE_SIZE : Number(request.query.limit);
    const limit = Number.isInteger(limitValue) ? Math.max(1, Math.min(USERS_PAGE_SIZE_MAX, limitValue)) : USERS_PAGE_SIZE;
    try {
      const { where, values } = searchClause(request.query.q);
      const [[count]] = await pool.execute(`SELECT COUNT(*) AS total FROM reader_users u ${where}`, values);
      const total = Number(count.total);
      const pages = Math.max(1, Math.ceil(total / limit));
      const page = Math.min(pageValue, pages);
      const [rows] = await pool.execute(
        `SELECT u.id, u.phone, u.first_name, u.last_name, u.is_student, u.student_no, u.unit_id, u.created_at, u.last_login_at,
                c.name AS unit_name, p.name AS province_name
         FROM reader_users u
         LEFT JOIN regions c ON c.id = u.unit_id
         LEFT JOIN regions p ON p.id = c.parent_id
         ${where}
         ORDER BY u.created_at DESC, u.id DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
        values,
      );
      const [[all]] = await pool.execute('SELECT COUNT(*) AS readers, COALESCE(SUM(is_student), 0) AS students FROM reader_users WHERE staff_user_id IS NULL');
      return response.json({
        items: rows.map((row) => ({
          id: Number(row.id),
          first_name: row.first_name,
          last_name: row.last_name,
          phone: row.phone,
          is_student: Boolean(row.is_student),
          student_no: row.student_no ?? null, // declared by the reader, not verified
          unit: row.unit_id ? { id: Number(row.unit_id), name: row.unit_name, province: row.province_name ?? null } : null,
          created_at: new Date(row.created_at).toISOString(),
          last_login_at: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
        })),
        page, pages, total, limit,
        totals: { readers: Number(all.readers), students: Number(all.students) },
      });
    } catch (error) {
      return next(error);
    }
  });

  const READER_NOT_FOUND = 'خواننده پیدا نشد.';
  const parseId = (value) => {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  };

  // Edit a reader's profile: first name, last name, student or not (with the student number) and the university centre. The phone
  // number is the account's identity and, as for the reader himself, never changes. Dashboard users' linked accounts
  // (staff_user_id) are not readers and cannot be edited here.
  router.patch('/users/:id', async (request, response, next) => {
    const id = parseId(request.params.id);
    if (!id) return response.status(400).json({ error: 'شناسهٔ خواننده معتبر نیست.' });
    const body = request.body && typeof request.body === 'object' ? request.body : {};
    if (Object.hasOwn(body, 'phone')) return response.status(400).json({ error: 'شمارهٔ موبایل پس از ثبت‌نام قابل تغییر نیست.' });
    try {
      const [rows] = await pool.execute(
        'SELECT id, phone, first_name, last_name, is_student, student_no, unit_id FROM reader_users WHERE id = ? AND staff_user_id IS NULL',
        [id],
      );
      if (!rows.length) return response.status(404).json({ error: READER_NOT_FOUND });
      const current = rows[0];
      const has = (key) => Object.hasOwn(body, key);
      const firstName = cleanPersonName(has('first_name') ? body.first_name : current.first_name);
      if (!firstName) return response.status(400).json({ error: 'نام را فقط با حروف و حداکثر ۶۰ نویسه وارد کنید.' });
      const lastName = cleanPersonName(has('last_name') ? body.last_name : current.last_name);
      if (!lastName) return response.status(400).json({ error: 'نام خانوادگی را فقط با حروف و حداکثر ۶۰ نویسه وارد کنید.' });
      const isStudent = has('is_student') ? body.is_student : Boolean(current.is_student);
      if (typeof isStudent !== 'boolean') return response.status(400).json({ error: 'مقدار «دانشجو» باید بله یا خیر باشد.' });
      let studentNo = null;
      if (isStudent) {
        studentNo = cleanStudentNumber(has('student_no') ? body.student_no : current.student_no);
        if (!studentNo) return response.status(400).json({ error: 'شمارهٔ دانشجویی را فقط با رقم و بین ۶ تا ۱۴ رقم وارد کنید.' });
      }
      const unitId = Number(has('unit_id') ? body.unit_id : current.unit_id);
      if (!Number.isSafeInteger(unitId) || unitId <= 0) return response.status(400).json({ error: 'مرکز دانشگاهی را انتخاب کنید.' });
      // The reader's own centre may have been hidden since he signed up: keeping it is fine, moving to a hidden one is not.
      if (unitId !== Number(current.unit_id)) {
        const [units] = await pool.execute("SELECT id FROM regions WHERE id = ? AND type = 'city' AND visibility_override <> 'hide' LIMIT 1", [unitId]);
        if (!units.length) return response.status(400).json({ error: 'مرکز دانشگاهی را انتخاب کنید.' });
      }
      try {
        await pool.execute(
          'UPDATE reader_users SET first_name = ?, last_name = ?, is_student = ?, student_no = ?, unit_id = ? WHERE id = ? AND staff_user_id IS NULL',
          [firstName, lastName, isStudent ? 1 : 0, studentNo, unitId, id],
        );
      } catch (error) {
        if (error?.code === 'ER_DUP_ENTRY') return response.status(409).json({ error: 'این شمارهٔ دانشجویی قبلاً برای حساب دیگری ثبت شده است.' });
        throw error;
      }
      // The audit row says who changed what, never the phone number or the student number itself.
      await pool.execute(
        `INSERT INTO audit_log (user_id, action, entity, entity_id, meta, ip) VALUES (?, 'reader.user.update', 'reader_user', ?, ?, ?)`,
        [request.user.id, id, JSON.stringify({
          changed: ['first_name', 'last_name', 'is_student', 'student_no', 'unit_id'].filter((name) => {
            const before = { first_name: current.first_name, last_name: current.last_name, is_student: Boolean(current.is_student), student_no: current.student_no ?? null, unit_id: current.unit_id === null ? null : Number(current.unit_id) }[name];
            const after = { first_name: firstName, last_name: lastName, is_student: isStudent, student_no: studentNo, unit_id: unitId }[name];
            return before !== after;
          }),
        }), request.ip ?? null],
      );
      return response.json({ ok: true, id });
    } catch (error) {
      return next(error);
    }
  });

  // Delete a reader's account for good: his sessions and bookmarks go with it (ON DELETE CASCADE) and his sign-in stops working
  // at once. He can sign up again with the same number.
  router.delete('/users/:id', async (request, response, next) => {
    const id = parseId(request.params.id);
    if (!id) return response.status(400).json({ error: 'شناسهٔ خواننده معتبر نیست.' });
    try {
      const [result] = await pool.execute('DELETE FROM reader_users WHERE id = ? AND staff_user_id IS NULL', [id]);
      if (!result.affectedRows) return response.status(404).json({ error: READER_NOT_FOUND });
      await pool.execute(
        `INSERT INTO audit_log (user_id, action, entity, entity_id, meta, ip) VALUES (?, 'reader.user.delete', 'reader_user', ?, ?, ?)`,
        [request.user.id, id, JSON.stringify({}), request.ip ?? null],
      );
      return response.json({ ok: true });
    } catch (error) {
      return next(error);
    }
  });

  // The webhook address (with the secret key) and the last events of the inbound-SMS login. Main admin only (the router above), never cached.
  // The key is part of the address and appears nowhere else: not in the settings, not in the audit log, not in a log line.
  router.get('/inbound', async (request, response, next) => {
    try {
      const key = await loadInboundKey(pool);
      const [rows] = await pool.execute('SELECT masked_phone, ip, outcome, reason, created_at FROM reader_inbound_log ORDER BY id DESC LIMIT 30');
      return response.json({
        webhook_url: key && config?.publicUrl ? webhookUrl(config.publicUrl, key) : null,
        recent: rows.map((row) => ({ phone: row.masked_phone, ip: row.ip, outcome: row.outcome, reason: row.reason, at: new Date(row.created_at).toISOString() })),
      });
    } catch (error) {
      return next(error);
    }
  });

  // A new secret key: the old address stops working at once. The key is generated here, never typed by a person.
  router.post('/inbound-key', async (request, response, next) => {
    try {
      const key = generateInboundKey();
      await pool.execute('INSERT INTO settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [INBOUND_KEY_SETTING, key]);
      await writeAudit(pool, request.user.id, 'reader.inbound_key.rotate', request, {}); // no key in the event
      return response.json({ ok: true, webhook_url: config?.publicUrl ? webhookUrl(config.publicUrl, key) : null });
    } catch (error) {
      return next(error);
    }
  });

  router.put('/settings', async (request, response, next) => {
    const checked = validateReaderSettingsUpdate(request.body);
    if (!checked.ok) return response.status(400).json({ error: checked.error });
    try {
      const current = await loadReaderSettings(pool);
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      const changed = Object.entries(checked.values).filter(([name, value]) => !same(current[name], value));
      if (!changed.length) return response.json({ ok: true, settings: current });
      const next_ = { ...current, ...Object.fromEntries(changed) };
      // The receiving method cannot be on without a receiving line (and the line cannot be removed while it is on).
      if (next_.auth_method === 'sms_receive' && !next_.inbound_line) {
        return response.status(400).json({ error: 'برای روش «ارسال پیامک از طرف خواننده» ابتدا شمارهٔ خط دریافت را وارد کنید.' });
      }
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        for (const [name, value] of changed) {
          await connection.execute(
            'INSERT INTO settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)',
            [readerSettingKey(name), storedValue(name, value)],
          );
        }
        // Switching signup on again by hand clears the notice of an automatic switch-off.
        if (changed.some(([name, value]) => name === 'signup_enabled' && value === true)) {
          await connection.execute('DELETE FROM settings WHERE k = ?', [SIGNUP_DISABLED_INFO_KEY]);
        }
        // The first time the receiving method is chosen the server makes the webhook key; later changes keep it.
        let keyMade = false;
        if (next_.auth_method === 'sms_receive' && !(await loadInboundKey(connection))) {
          await connection.execute('INSERT INTO settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [INBOUND_KEY_SETTING, generateInboundKey()]);
          keyMade = true;
        }
        const method = changed.find(([name]) => name === 'auth_method');
        const others = changed.filter(([name]) => name !== 'auth_method');
        if (method) await writeAudit(connection, request.user.id, 'reader.auth_method.change', request, { from: current.auth_method, to: method[1], key_generated: keyMade });
        if (others.length) {
          await writeAudit(connection, request.user.id, 'reader.settings.update', request, {
            changed: Object.fromEntries(others.map(([name, value]) => [name, { from: current[name], to: value }])),
          });
        }
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
      events.emit('settings.changed');
      return response.json({ ok: true, settings: next_ });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
