import express from 'express';
import { createRateLimiter } from '../lib/ratelimit.js';
import { redactForLog } from '../lib/log-redact.js';
import { hashInboundCode, extractCodes, ipAllowed, normalizeLine, sameSecret } from '../lib/reader-inbound.js';
import { maskPhone, normalizePhone, sameHex } from '../lib/reader-auth.js';
import { loadInboundKey, loadReaderSettings } from '../lib/reader-settings.js';

const FIELD_MAX = 64;
// Reasons that any stranger can trigger (no key needed) are written to the log at most once a minute each, so the log cannot be flooded.
const THROTTLED_REASONS = new Set(['bad_key', 'wrong_method', 'ip_blocked']);
const THROTTLE_MS = 60_000;

const reply = (response, status = 200) => response.status(status).type('text/plain').set('Cache-Control', 'no-store').send(status === 200 ? 'ok' : 'error');

// The receiving end of the provider's "incoming SMS" call: GET /api/reader/auth/sms-in?key=…&from=@FROM&to=@TO&message=@MSG
// (POST with the same fields is accepted too). It is not under the reader session, needs no cookies and is mounted before the
// JSON-only CSRF guard on purpose. Whatever is wrong with a call, the answer says nothing: 200 «ok» (so the provider does not retry),
// and only the main admin's log (reader_inbound_log) learns the reason code.
export function createInboundWebhookRouter({ pool, config, clock = Date.now }) {
  const router = express.Router();
  const throttled = new Map();
  const perIp = createRateLimiter({ limit: 120, windowMs: 60_000, clock, reject: (request, response) => reply(response, 429) });
  const global = createRateLimiter({ limit: 600, windowMs: 60_000, clock, keyOf: () => 'all', reject: (request, response) => reply(response, 429) });

  async function record(request, outcome, reason, phone = null) {
    const now = clock();
    if (THROTTLED_REASONS.has(reason)) {
      if (now - (throttled.get(reason) ?? 0) < THROTTLE_MS) return;
      throttled.set(reason, now);
    }
    try {
      await pool.execute(
        'INSERT INTO reader_inbound_log (masked_phone, ip, outcome, reason, created_at) VALUES (?, ?, ?, ?, ?)',
        [phone ? maskPhone(phone) : null, request.ip ?? null, outcome, reason, new Date(now)],
      );
    } catch {} // the log is a convenience; a failing log must never turn a received SMS into an error
  }

  router.use(perIp, global);
  router.use(express.urlencoded({ extended: false, limit: '8kb' }), express.json({ limit: '8kb' }));

  router.all('/', async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'POST') return reply(response, 405);
    const pick = (name) => {
      const value = request.query?.[name] ?? request.body?.[name];
      const one = Array.isArray(value) ? value[0] : value;
      return typeof one === 'string' ? one : '';
    };
    try {
      const [settings, storedKey] = await Promise.all([loadReaderSettings(pool), loadInboundKey(pool)]);
      const given = pick('key').slice(0, FIELD_MAX * 2);
      if (!sameSecret(given, storedKey)) { await record(request, 'ignored', 'bad_key'); return reply(response); }
      if (settings.auth_method !== 'sms_receive') { await record(request, 'ignored', 'wrong_method'); return reply(response); }
      if (!ipAllowed(settings.inbound_ips, request.ip)) { await record(request, 'ignored', 'ip_blocked'); return reply(response); }

      const phone = normalizePhone(pick('from').slice(0, FIELD_MAX)); // short codes and alphanumeric senders are not mobile numbers
      if (!phone) { await record(request, 'ignored', 'bad_sender'); return reply(response); }
      const ourLine = normalizeLine(settings.inbound_line);
      const toLine = normalizeLine(pick('to').slice(0, FIELD_MAX));
      if (!ourLine || ourLine !== toLine) { await record(request, 'ignored', 'wrong_line', phone); return reply(response); }
      const codes = extractCodes(pick('message'));
      if (!codes.length) { await record(request, 'ignored', 'no_code', phone); return reply(response); }

      const now = new Date(clock());
      const [open] = await pool.execute(
        'SELECT id, code_hash FROM reader_inbound_challenges WHERE phone = ? AND confirmed_at IS NULL AND consumed_at IS NULL AND expires_at > ? ORDER BY id DESC',
        [phone, now],
      );
      // The hash includes the phone, so a code can only ever match a challenge of the number the SMS came from.
      for (const code of codes) {
        const hash = hashInboundCode(config.appSecret, phone, code);
        const match = open.find((row) => sameHex(row.code_hash, hash));
        if (!match) continue;
        const [done] = await pool.execute(
          'UPDATE reader_inbound_challenges SET confirmed_at = ? WHERE id = ? AND confirmed_at IS NULL AND consumed_at IS NULL AND expires_at > ?',
          [now, match.id, now],
        );
        if (done.affectedRows === 1) { await record(request, 'confirmed', 'confirmed', phone); return reply(response); }
      }
      await record(request, 'ignored', 'no_match', phone);
      return reply(response);
    } catch (error) {
      console.error(`Inbound SMS webhook failed: ${redactForLog(error.message)}`);
      return reply(response, 500);
    }
  });

  // A body that cannot be read (broken, too large) is answered like every other call: nothing is explained.
  router.use((error, request, response, next) => reply(response));
  return router;
}
