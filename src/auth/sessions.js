import { createHash, randomBytes } from 'node:crypto';

export const SESSION_TTL_SECONDS = 24 * 60 * 60;
export const DEVICE_TTL_SECONDS = 30 * 24 * 60 * 60;
export const PENDING_TTL_SECONDS = 10 * 60;

export function cookieName(kind, nodeEnv = process.env.NODE_ENV) {
  if (kind === 'session') return nodeEnv === 'production' ? '__Host-pnu_session' : 'pnu_session';
  if (kind === 'device') return nodeEnv === 'production' ? '__Host-pnu_device' : 'pnu_device';
  if (kind === 'pending') return nodeEnv === 'production' ? '__Host-pnu_pending' : 'pnu_pending';
  throw new TypeError(`Unknown cookie kind: ${kind}`);
}

export function cookieOptions(kind, nodeEnv = process.env.NODE_ENV, now = Date.now()) {
  const maxAgeSeconds = kind === 'session'
    ? SESSION_TTL_SECONDS
    : kind === 'device'
      ? DEVICE_TTL_SECONDS
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

export function setOpaqueCookie(response, kind, token, nodeEnv, now = Date.now()) {
  response.cookie(cookieName(kind, nodeEnv), token, cookieOptions(kind, nodeEnv, now));
}

export function clearOpaqueCookie(response, kind, nodeEnv) {
  response.clearCookie(cookieName(kind, nodeEnv), {
    httpOnly: true,
    secure: nodeEnv === 'production',
    sameSite: 'lax',
    path: '/',
  });
}

export async function createSession(pool, userId, request, now = Date.now()) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now + SESSION_TTL_SECONDS * 1000);
  await pool.execute(
    `INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?)`,
    [hashToken(token), userId, expiresAt, request.ip ?? null, request.get?.('user-agent')?.slice(0, 512) ?? null],
  );
  return { token, expiresAt };
}

export async function createTrustedDevice(pool, userId, request, now = Date.now()) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now + DEVICE_TTL_SECONDS * 1000);
  await pool.execute(
    `INSERT INTO trusted_devices (user_id, token_hash, user_agent, ip, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    [userId, hashToken(token), request.get?.('user-agent')?.slice(0, 512) ?? null, request.ip ?? null, expiresAt],
  );
  return { token, expiresAt };
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
    issue(userId, now = clock()) {
      prune(now);
      const token = randomBytes(32).toString('base64url');
      entries.set(keyFor(token), { userId, expiresAt: now + PENDING_TTL_SECONDS * 1000, totpSecret: null });
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
