import express from 'express';

// Each signed-in user connects their own bot and channel here. The bot token is accepted, checked against
// Telegram and stored encrypted; it is never sent back to the browser.
export function createTelegramRouter({ pool, telegram, clock = Date.now }) {
  const router = express.Router();
  const lastCheck = new Map();

  // Checking a token/channel makes real requests to Telegram, so repeated clicks are slowed down per user.
  // Each kind of action has its own timer, so "save" followed at once by "send a test message" is fine.
  function tooSoon(userId, kind) {
    const now = clock();
    const key = `${userId}:${kind}`;
    const previous = lastCheck.get(key) ?? 0;
    if (now - previous < 4000) return true;
    lastCheck.set(key, now);
    if (lastCheck.size > 500) for (const [key, time] of lastCheck) if (now - time > 60_000) lastCheck.delete(key);
    return false;
  }

  function audit(request, action) {
    return pool.execute(
      `INSERT INTO audit_log (user_id, action, entity, entity_id, ip) VALUES (?, ?, 'telegram', ?, ?)`,
      [request.user.id, action, request.user.id, request.ip ?? null],
    ).catch(() => {});
  }

  router.get('/', async (request, response, next) => {
    try { return response.json(await telegram.summary(request.user.id)); } catch (error) { return next(error); }
  });

  router.put('/', async (request, response, next) => {
    try {
      const body = request.body ?? {};
      if (typeof body.channel !== 'string' || typeof body.enabled !== 'boolean' ||
          (body.bot_token !== undefined && typeof body.bot_token !== 'string')) {
        return response.status(400).json({ error: 'اطلاعات ارسالی معتبر نیست.' });
      }
      if (tooSoon(request.user.id, 'save')) return response.status(429).json({ error: 'کمی صبر کنید و دوباره تلاش کنید.' });
      const result = await telegram.save(request.user.id, { botToken: body.bot_token, channel: body.channel, enabled: body.enabled });
      if (result.error) return response.status(400).json({ error: result.error });
      await audit(request, 'telegram.save');
      return response.json(await telegram.summary(request.user.id));
    } catch (error) { return next(error); }
  });

  router.post('/enabled', async (request, response, next) => {
    try {
      if (typeof request.body?.enabled !== 'boolean') return response.status(400).json({ error: 'اطلاعات ارسالی معتبر نیست.' });
      if (request.body.enabled && tooSoon(request.user.id, 'save')) return response.status(429).json({ error: 'کمی صبر کنید و دوباره تلاش کنید.' });
      const [rows] = await pool.execute('SELECT chat_ref FROM telegram_channels WHERE user_id = ?', [request.user.id]);
      if (!rows.length) return response.status(404).json({ error: 'اتصال تلگرام تنظیم نشده است.' });
      if (request.body.enabled) {
        // turning it back on re-checks the connection
        const result = await telegram.save(request.user.id, { channel: rows[0].chat_ref, enabled: true });
        if (result.error) return response.status(400).json({ error: result.error });
      } else {
        await telegram.setEnabled(request.user.id, false);
      }
      await audit(request, request.body.enabled ? 'telegram.enable' : 'telegram.disable');
      return response.json(await telegram.summary(request.user.id));
    } catch (error) { return next(error); }
  });

  router.post('/test', async (request, response, next) => {
    try {
      if (tooSoon(request.user.id, 'test')) return response.status(429).json({ error: 'کمی صبر کنید و دوباره تلاش کنید.' });
      const [regions] = await pool.execute('SELECT name, type FROM regions WHERE id = ?', [request.user.region_id]);
      const region = regions[0];
      const unitName = !region ? 'این مجموعه' : region.type === 'country' ? 'کل کشور' : region.type === 'province' ? `استان ${region.name}` : region.name;
      const result = await telegram.sendTest(request.user.id, { unitName });
      if (result.error) return response.status(400).json({ error: result.error });
      return response.json(await telegram.summary(request.user.id));
    } catch (error) { return next(error); }
  });

  router.delete('/', async (request, response, next) => {
    try {
      const removed = await telegram.remove(request.user.id);
      if (removed) await audit(request, 'telegram.remove');
      return response.json({ configured: false });
    } catch (error) { return next(error); }
  });

  return router;
}
