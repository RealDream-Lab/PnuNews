import { readLimitedText } from './net-guard.js';

// Client of the ippanel SMS service (edge API): sends a pattern SMS and reads the credit.
//
// The API key goes in the Authorization header exactly as given (no «Bearer»). Nothing returned or thrown from here
// contains the key, the phone number's text or the code: callers can log the result as it is.
//
// A send is never repeated here, whatever happens: after a timeout the SMS may still have been delivered and charged.
export function createIppanelClient({
  baseUrl = 'https://edge.ippanel.com/v1', apiKey = '', patternCode = '', patternVariable = 'OPT', fromNumber = '',
  dryRun = false, fetchImpl = fetch, timeoutMs = 8000, logger = console,
} = {}) {
  const configured = dryRun || Boolean(apiKey && patternCode && fromNumber);

  async function request(path, { method = 'GET', body } = {}) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: apiKey },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error', // the key must never follow a redirect to another host
      });
    } catch (error) {
      return { transport: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network' };
    }
    let parsed = null;
    try { parsed = JSON.parse(await readLimitedText(response, 64 * 1024)); } catch { parsed = null; }
    return { status: response.status, parsed };
  }

  const failure = (result) => ({
    ok: false,
    kind: result.parsed && typeof result.parsed === 'object' ? 'rejected' : 'invalid_response',
    status: result.status,
    messageCode: typeof result.parsed?.meta?.message_code === 'string' ? result.parsed.meta.message_code.slice(0, 20) : null,
  });

  return {
    configured,
    dryRun,

    // phone: E.164 (+98912...). The code goes into the pattern's variable (OPT by default, a number-type variable).
    // Success is meta.status === true together with an outbox id; the HTTP status alone is not enough.
    async sendPattern(phone, code) {
      if (dryRun) {
        logger.info(`[ippanel dry-run] code for ${phone}: ${code}`);
        return { ok: true, outboxId: 'dry-run', dryRun: true };
      }
      if (!configured) return { ok: false, kind: 'not_configured' };
      const result = await request('/api/send', {
        method: 'POST',
        body: { sending_type: 'pattern', from_number: fromNumber, code: patternCode, recipients: [phone], params: { [patternVariable]: String(code) } },
      });
      if (result.transport) return { ok: false, kind: result.transport };
      const ids = result.parsed?.data?.message_outbox_ids;
      if (result.parsed?.meta?.status === true && Array.isArray(ids) && ids.length) return { ok: true, outboxId: String(ids[0]).slice(0, 40) };
      return failure(result);
    },

    // Credit in RIAL.
    async getCredit() {
      if (dryRun) return { ok: true, credit: 50_000_000, updatedAt: null, dryRun: true };
      if (!configured) return { ok: false, kind: 'not_configured' };
      const result = await request('/api/payment/credit/mine');
      if (result.transport) return { ok: false, kind: result.transport };
      const credit = result.parsed?.data?.credit;
      if (result.parsed?.meta?.status === true && typeof credit === 'number' && Number.isFinite(credit) && credit >= 0) {
        return { ok: true, credit, updatedAt: typeof result.parsed.data.updated_at === 'string' ? result.parsed.data.updated_at : null };
      }
      return failure(result);
    },
  };
}
