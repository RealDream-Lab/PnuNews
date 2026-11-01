// Minimal Telegram Bot API client.
//
// Requests go to `${base}/bot<TOKEN>/<method>`. The first base is the Cloudflare Worker that forwards to
// api.telegram.org; an optional second base is tried when the first one cannot be reached. A bot token is a
// password: it is only ever placed in the request address and is scrubbed from every error message.

export const TOKEN_PATTERN = /^\d{6,12}:[A-Za-z0-9_-]{30,60}$/;

export class TelegramError extends Error {
  constructor(message, { code = 0, retryAfter = 0, network = false, detail = '' } = {}) {
    super(message);
    this.name = 'TelegramError';
    this.code = code;
    this.retryAfter = retryAfter;
    this.network = network;
    // Short technical hint for network failures (timeout, ECONNRESET, HTTP 502 ...). Never contains the token.
    this.detail = detail;
  }
}

// "@name", "name", a t.me link or a numeric id (-100...) -> "@name" or "-100..."; anything else -> null.
export function parseChannelRef(input) {
  if (typeof input !== 'string') return null;
  let value = input.trim();
  const link = /^(?:https?:\/\/)?(?:t|telegram)\.me\/([A-Za-z][A-Za-z0-9_]{4,31})\/?$/i.exec(value);
  if (link) value = link[1];
  if (/^-\d{5,20}$/.test(value)) return value;
  if (/^@?[A-Za-z][A-Za-z0-9_]{4,31}$/.test(value)) return `@${value.replace(/^@/, '')}`;
  return null;
}

function scrub(text, token) {
  let result = String(text ?? '');
  if (token) result = result.split(token).join('***');
  return result.replace(/\d{6,12}:[A-Za-z0-9_-]{30,60}/g, '***');
}

// What the person sees for a failure (Persian), never the raw token-bearing text.
export function describeTelegramError(error) {
  if (!(error instanceof TelegramError)) return 'خطای ناشناخته در ارتباط با تلگرام.';
  if (error.network) return `اتصال به تلگرام برقرار نشد${error.detail ? ` (${error.detail})` : ''}.`;
  const text = String(error.message).toLowerCase();
  if (error.code === 401) return 'توکن ربات معتبر نیست یا ابطال شده است.';
  if (error.code === 429) return 'تلگرام موقتاً درخواست‌ها را محدود کرده است؛ کمی بعد دوباره تلاش می‌شود.';
  if (text.includes('chat not found')) return 'کانال پیدا نشد؛ شناسهٔ کانال را بررسی کنید و ربات را مدیر کانال کنید.';
  if (error.code === 403 || text.includes('not enough rights') || text.includes('need administrator')) {
    return 'ربات اجازهٔ ارسال در این کانال را ندارد؛ آن را با دسترسی «ارسال پیام» مدیر کانال کنید.';
  }
  if (text.includes('message is not modified')) return 'پیام تغییری نکرده است.';
  if (text.includes('message to edit not found') || text.includes("message can't be edited")) return 'پیام در کانال پیدا نشد یا قابل ویرایش نیست.';
  return `تلگرام درخواست را نپذیرفت (${error.code || 'نامشخص'}).`;
}

export function createTelegramClient({ fetchImpl = fetch, baseUrl, fallbackUrl = '', timeoutMs = 25_000 } = {}) {
  const bases = [baseUrl, fallbackUrl].filter(Boolean).map((base) => base.replace(/\/+$/, ''));
  if (!bases.length) throw new TypeError('Telegram base URL is required');

  // params: plain values or objects (objects are sent as JSON text); files: { name: { data, filename, type } }
  async function call(token, method, params = {}, files = {}) {
    if (!TOKEN_PATTERN.test(token)) throw new TelegramError('Invalid token format', { code: 401 });
    if (!/^[A-Za-z]+$/.test(method)) throw new TypeError('Invalid method');
    const hasFiles = Object.keys(files).length > 0;
    let lastFailure = new TelegramError('no response', { network: true, detail: 'no response' });
    // Uploading a photo through the proxy takes longer than a small JSON call.
    const effectiveTimeout = hasFiles ? Math.max(timeoutMs, 60_000) : timeoutMs;

    for (const base of bases) {
      let body;
      const headers = {};
      if (hasFiles) {
        body = new FormData();
        for (const [name, value] of Object.entries(params)) {
          if (value === undefined || value === null) continue;
          body.append(name, typeof value === 'object' ? JSON.stringify(value) : String(value));
        }
        for (const [name, file] of Object.entries(files)) {
          body.append(name, new Blob([file.data], { type: file.type ?? 'application/octet-stream' }), file.filename ?? name);
        }
      } else {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(params);
      }

      let response;
      try {
        response = await fetchImpl(`${base}/bot${token}/${method}`, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(effectiveTimeout),
          redirect: 'error',
        });
      } catch (cause) {
        const timedOut = cause?.name === 'TimeoutError' || cause?.name === 'AbortError';
        const detail = timedOut ? 'timeout' : String(cause?.cause?.code || cause?.name || 'network').slice(0, 40);
        lastFailure = new TelegramError('network error', { network: true, detail });
        continue;
      }

      let payload = null;
      try { payload = await response.json(); } catch { payload = null; }
      if (!payload || typeof payload !== 'object' || typeof payload.ok !== 'boolean') {
        // Not a Telegram answer (the proxy itself failed): try the next address.
        lastFailure = new TelegramError(`unexpected response ${response.status}`, { network: true, code: response.status, detail: `پاسخ غیرتلگرامی از پروکسی، HTTP ${response.status}` });
        continue;
      }
      if (payload.ok) return payload.result;
      const error = new TelegramError(scrub(payload.description, token), {
        code: Number(payload.error_code) || response.status,
        retryAfter: Number(payload.parameters?.retry_after) || 0,
      });
      // Telegram itself answered: a server-side hiccup may still work on the other address, anything else will not.
      if (error.code >= 500 && base !== bases[bases.length - 1]) { lastFailure = error; continue; }
      throw error;
    }
    throw lastFailure;
  }

  return { call };
}
