import { appEvents } from '../events.js';
import { loadReaderSettings } from './reader-settings.js';

export const SIGNUP_DISABLED_INFO_KEY = 'reader_signup_disabled_info';
const DAY_MS = 24 * 60 * 60_000;
const FAILURE_WINDOW_MS = 10 * 60_000;
const FAILURES_TO_SWITCH_OFF = 5;

// The SMS budget of the reader accounts: what is left of the ippanel credit, how many codes went out in the last 24 hours
// and what has failed lately. It decides before every send (checkBeforeSend), learns after it (afterSend) and, when the
// money or the service is running out, switches reader signup off by itself (disableSignup) and says why.
//
// The credit is read from ippanel at most every `creditTtlMs`; between two readings each sent SMS is subtracted at the
// assumed cost, so the estimate follows the sends. A failed reading never blocks a send: it is only reported (status).
export function createSmsBudget({ pool, ippanel, clock = Date.now, events = appEvents, creditTtlMs = 5 * 60_000, creditRetryMs = 60_000, logger = console }) {
  let creditCache = null; // { credit (rial), fetchedAt, updatedAt }
  let creditError = null; // { kind, messageCode, at } of the last failed reading

  async function readCredit({ force = false } = {}) {
    const now = clock();
    if (!force) {
      if (creditCache && now - creditCache.fetchedAt < creditTtlMs) return creditCache;
      if (creditError && now - creditError.at < creditRetryMs) return creditCache; // do not hammer a failing service
    }
    const result = await ippanel.getCredit();
    if (result.ok) {
      creditCache = { credit: result.credit, fetchedAt: now, updatedAt: result.updatedAt ?? null };
      creditError = null;
    } else {
      creditError = { kind: result.kind, messageCode: result.messageCode ?? null, at: now };
    }
    return creditCache;
  }

  async function count(sql, since) {
    const [rows] = await pool.execute(sql, [new Date(since)]);
    return Number(rows[0]?.n ?? 0);
  }

  // Switches signup off, once: only when it is on, so a burst of failures writes one audit row and one notice.
  async function disableSignup(reason, detail = {}) {
    const [result] = await pool.execute("UPDATE settings SET v = '0' WHERE k = 'reader_signup_enabled' AND v = '1'");
    if (!result.affectedRows) return false;
    const info = { reason, at: new Date(clock()).toISOString(), ...detail };
    await pool.execute('INSERT INTO settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [SIGNUP_DISABLED_INFO_KEY, JSON.stringify(info)]);
    await pool.execute(
      "INSERT INTO audit_log (user_id, action, entity, entity_id, meta, ip) VALUES (NULL, 'reader.signup.auto_disabled', 'reader_settings', NULL, ?, NULL)",
      [JSON.stringify(info)],
    );
    events.emit('settings.changed');
    logger.warn(`Reader signup switched off automatically: ${reason}`);
    return true;
  }

  return {
    readCredit,
    disableSignup,

    // { allowed: true } or { allowed: false, reason: 'daily_cap' | 'low_credit' }.
    async checkBeforeSend() {
      const settings = await loadReaderSettings(pool);
      if (await count('SELECT COUNT(*) AS n FROM sms_log WHERE created_at > ?', clock() - DAY_MS) >= settings.sms_daily_cap) {
        return { allowed: false, reason: 'daily_cap' };
      }
      const credit = await readCredit();
      if (credit) {
        const remaining = Math.floor(credit.credit / settings.sms_cost_rial);
        if (remaining < settings.sms_min_remaining) {
          await disableSignup('low_credit', { credit_rial: credit.credit, remaining });
          return { allowed: false, reason: 'low_credit' };
        }
      }
      return { allowed: true };
    },

    // outcome: what ippanel.sendPattern returned. Call it after the send has been written to sms_log.
    async afterSend(outcome, { costRial }) {
      if (outcome.ok) {
        if (creditCache) creditCache = { ...creditCache, credit: Math.max(0, creditCache.credit - costRial) };
        return;
      }
      if (outcome.kind === 'not_configured') return;
      const failures = await count('SELECT COUNT(*) AS n FROM sms_log WHERE ok = 0 AND created_at > ?', clock() - FAILURE_WINDOW_MS);
      if (failures >= FAILURES_TO_SWITCH_OFF) await disableSignup('send_failures', { failures, last: outcome.messageCode ?? outcome.kind });
    },

    // Everything the main admin's panel shows about the SMS budget. force: read the credit from ippanel now.
    async status({ force = false } = {}) {
      const settings = await loadReaderSettings(pool);
      const credit = await readCredit({ force });
      const [infoRows] = await pool.query('SELECT v FROM settings WHERE k = ?', [SIGNUP_DISABLED_INFO_KEY]);
      let disabledInfo = null;
      try { disabledInfo = infoRows[0] ? JSON.parse(infoRows[0].v) : null; } catch { disabledInfo = null; }
      const [failureRows] = await pool.execute('SELECT masked_phone, message_code, created_at FROM sms_log WHERE ok = 0 ORDER BY id DESC LIMIT 20');
      return {
        configured: ippanel.configured,
        dry_run: Boolean(ippanel.dryRun),
        credit_rial: credit ? credit.credit : null,
        credit_checked_at: credit ? new Date(credit.fetchedAt).toISOString() : null,
        credit_error: creditError ? { kind: creditError.kind, message_code: creditError.messageCode, at: new Date(creditError.at).toISOString() } : null,
        cost_rial: settings.sms_cost_rial,
        remaining: credit ? Math.floor(credit.credit / settings.sms_cost_rial) : null,
        min_remaining: settings.sms_min_remaining,
        daily_cap: settings.sms_daily_cap,
        sent_24h: await count('SELECT COUNT(*) AS n FROM sms_log WHERE created_at > ?', clock() - DAY_MS),
        recent_failures: failureRows.map((row) => ({ phone: row.masked_phone, code: row.message_code, at: new Date(row.created_at).toISOString() })),
        signup_disabled: disabledInfo,
      };
    },
  };
}
