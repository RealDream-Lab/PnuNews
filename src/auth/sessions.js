import { createHash, randomBytes } from 'node:crypto';

export const SESSION_TTL_SECONDS = 24 * 60 * 60;
// «به یاد سپاری» (فقط موبایل): ده سال از آخرین استفاده؛ مرورگرها خودشان عمر کوکی را حدود ۴۰۰ روز محدود می‌کنند،
// برای همین هر بار که نشست استفاده شود (حداکثر روزی یک‌بار) کوکی و تاریخ انقضای پایگاه داده دوباره تمدید می‌شود.
export const REMEMBER_TTL_SECONDS = 10 * 365 * 24 * 60 * 60;
export const REMEMBER_RENEW_AFTER_SECONDS = 24 * 60 * 60;
export const PENDING_TTL_SECONDS = 10 * 60;

// موبایل = تلفن همراه شخصی. تشخیص سمت سرور است تا نسخهٔ دسکتاپ هرگز نشست ماندگار نگیرد، حتی اگر کلاینت چیز دیگری بگوید.
// (iPad که خود را «Macintosh» معرفی می‌کند دسکتاپ حساب می‌شود.)
export function isMobileUserAgent(userAgent = '') {
  return /Android.+Mobile|iPhone|iPod|Windows Phone|IEMobile|Opera Mini|BlackBerry|\bMobile\b/i.test(String(userAgent));
}

export function cookieName(kind, nodeEnv = process.env.NODE_ENV) {
  if (kind === 'session') return nodeEnv === 'production' ? '__Host-pnu_session' : 'pnu_session';
  if (kind === 'pending') return nodeEnv === 'production' ? '__Host-pnu_pending' : 'pnu_pending';
  throw new TypeError(`Unknown cookie kind: ${kind}`);
}

export function cookieOptions(kind, nodeEnv = process.env.NODE_ENV, now = Date.now(), { remember = false } = {}) {
  const maxAgeSeconds = kind === 'session'
    ? (remember ? REMEMBER_TTL_SECONDS : SESSION_TTL_SECONDS)
    : PENDING_TTL_SECONDS;
  return {
    httpOnly: true,
    secure: nodeEnv === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds * 1000,
    expires: new Date(now + maxAgeSeconds * 1000),
  };
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest();
}

export function parseCookies(header = '') {
  const cookies = new Map();
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!cookies.has(name)) cookies.set(name, value);
  }
  return cookies;
}

export function readCookie(request, kind, nodeEnv) {
  const name = cookieName(kind, nodeEnv);
  return parseCookies(request.headers.cookie).get(name) ?? null;
}

export function setOpaqueCookie(response, kind, token, nodeEnv, now = Date.now(), options = {}) {
  response.cookie(cookieName(kind, nodeEnv), token, cookieOptions(kind, nodeEnv, now, options));
}

export function clearOpaqueCookie(response, kind, nodeEnv) {
  response.clearCookie(cookieName(kind, nodeEnv), {
    httpOnly: true,
    secure: nodeEnv === 'production',
    sameSite: 'lax',
    path: '/',
  });
}

// هر دستگاه فقط یک نشست دارد: ورود تازه، نشست قبلیِ همان مرورگر (از روی کوکی) و نشست‌های هم‌User-Agent همان کاربر را جایگزین می‌کند.
export async function replaceDeviceSessions(pool, userId, request, cookieToken) {
  const userAgent = request.get?.('user-agent')?.slice(0, 512) ?? null;
  const cookieHash = cookieToken ? hashToken(cookieToken) : Buffer.alloc(32);
  await pool.execute(
    'DELETE FROM sessions WHERE user_id = ? AND (token_hash = ? OR user_agent <=> ?)',
    [userId, cookieHash, userAgent],
  );
}

export async function createSession(pool, userId, request, now = Date.now(), { remember = false } = {}) {
  const token = randomBytes(32).toString('base64url');
  const ttl = remember ? REMEMBER_TTL_SECONDS : SESSION_TTL_SECONDS;
  const expiresAt = new Date(now + ttl * 1000);
  await pool.execute(
    `INSERT INTO sessions (token_hash, user_id, expires_at, remember, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [hashToken(token), userId, expiresAt, remember ? 1 : 0, request.ip ?? null, request.get?.('user-agent')?.slice(0, 512) ?? null],
  );
  return { token, expiresAt, remember };
}


export function createPendingStore(clock = Date.now) {
  const entries = new Map();
  const keyFor = (token) => hashToken(token).toString('hex');

  function prune(now = clock()) {
    for (const [key, value] of entries) {
      if (value.expiresAt <= now) entries.delete(key);
    }
  }

  return {
    issue(userId, now = clock(), extra = {}) {
      prune(now);
      const token = randomBytes(32).toString('base64url');
      entries.set(keyFor(token), { userId, expiresAt: now + PENDING_TTL_SECONDS * 1000, remember: Boolean(extra.remember) });
      return token;
    },
    get(token, now = clock()) {
      if (!token) return null;
      prune(now);
      const value = entries.get(keyFor(token));
      return value && value.expiresAt > now ? value : null;
    },
    delete(token) {
      if (token) entries.delete(keyFor(token));
    },
    size() {
      prune();
      return entries.size;
    },
  };
}
