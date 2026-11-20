import express from 'express';
import { canManageRegion } from '../auth/policy.js';
import { appEvents } from '../events.js';
import { loadReaderSettings, readerSettingKey, storedValue, validateReaderSettingsUpdate } from '../lib/reader-settings.js';

function writeAudit(connection, actorId, action, request, meta) {
  return connection.execute(
    `INSERT INTO audit_log (user_id, action, entity, entity_id, meta, ip)
     VALUES (?, ?, 'reader_settings', NULL, ?, ?)`,
    [actorId, action, JSON.stringify(meta), request.ip ?? null],
  );
}

// Reader accounts and the SMS budget belong to the main admin alone. The caller mounts this behind the admin
// authentication, which sets request.user.
export function createReaderAdminRouter({ pool, events = appEvents }) {
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

  router.put('/settings', async (request, response, next) => {
    const checked = validateReaderSettingsUpdate(request.body);
    if (!checked.ok) return response.status(400).json({ error: checked.error });
    try {
      const current = await loadReaderSettings(pool);
      const changed = Object.entries(checked.values).filter(([name, value]) => current[name] !== value);
      if (!changed.length) return response.json({ ok: true, settings: current });
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        for (const [name, value] of changed) {
          await connection.execute(
            'INSERT INTO settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)',
            [readerSettingKey(name), storedValue(name, value)],
          );
        }
        await writeAudit(connection, request.user.id, 'reader.settings.update', request, {
          changed: Object.fromEntries(changed.map(([name, value]) => [name, { from: current[name], to: value }])),
        });
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
      events.emit('settings.changed');
      return response.json({ ok: true, settings: { ...current, ...Object.fromEntries(changed) } });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
