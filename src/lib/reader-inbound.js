import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import net from 'node:net';
import { normalizeDigits } from './reader-auth.js';

// Helpers of the "SMS sent by the reader" login (auth_method = sms_receive). Pure functions only; the routes own the SQL.

export const INBOUND_TTL_MS = 5 * 60_000;
// A challenge the webhook has confirmed can still be picked up by its browser for this long, even when the five minutes ran out
// a moment after the SMS arrived (the reader's next poll may be a few seconds away).
export const INBOUND_CONFIRM_GRACE_MS = 2 * 60_000;
export const INBOUND_MAX_OPEN_PER_PHONE = 3;
export const INBOUND_MAX_MESSAGE_CHARS = 1000;
export const INBOUND_MAX_CODES_PER_MESSAGE = 10;
export const INBOUND_LOG_KEEP_MS = 30 * 24 * 60 * 60_000;

// The text the reader sends. The code stays in ASCII digits; the webhook accepts Persian digits as well.
export const inboundBody = (code) => `کد ورود به اخبار پیام‌نور: ${code}`;

export const hashInboundCode = (secret, phone, code) => createHmac('sha256', secret).update(`reader-inbound:${phone}:${code}`).digest('hex');

// The handle lives in the reader's browser only; the table holds its hash.
export const generateHandle = () => randomBytes(32).toString('base64url');
export const isHandle = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
export const hashHandle = (handle) => createHash('sha256').update(`reader-inbound-handle:${handle}`).digest('hex');

export const generateInboundKey = () => randomBytes(32).toString('hex');

// Constant-time comparison that does not even leak the length of the stored key.
export function sameSecret(given, stored) {
  if (typeof given !== 'string' || typeof stored !== 'string' || !stored) return false;
  const left = createHash('sha256').update(given).digest();
  const right = createHash('sha256').update(stored).digest();
  return timingSafeEqual(left, right);
}

// A receiving line (ours or the provider's `to`) as plain digits: 985000262720 for +985000262720, 00985000262720 and 05000262720.
// Some provider lines are long (14 digits after the country code), so up to 18 digits are accepted.
export function normalizeLine(value) {
  let digits = normalizeDigits(value).replace(/[\s\-().\u200c\u200e\u200f]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('00')) digits = digits.slice(2);
  else if (digits.startsWith('0')) digits = `98${digits.slice(1)}`;
  return /^\d{8,18}$/.test(digits) ? digits : null;
}

// What the main admin types as the line: digits only (Persian or Arabic digits are converted), 8 to 16 digits, with or without «98».
export function cleanLineSetting(value) {
  const digits = normalizeDigits(value).trim();
  return /^\d{8,16}$/.test(digits) ? digits : null;
}

// The line with the country code, always: «5000262720» and «985000262720» are both 985000262720.
const withCountry = (digits) => (digits.startsWith('98') ? digits : `98${digits}`);

// Do two lines mean the same receiving line? Providers report `to` with or without the country code, with 0, 00 or +, so a line and
// the same line with «98» in front are the same line. Nothing else is: a different number never matches.
export function sameLine(a, b) {
  const left = normalizeLine(a);
  const right = normalizeLine(b);
  if (!left || !right) return false;
  return left === right || withCountry(left) === withCountry(right) || `98${left}` === right || left === `98${right}`;
}

export const lineInternational = (digits) => { const line = normalizeLine(digits); return `+${line ? withCountry(line) : digits}`; };

const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g;

// Every standalone 6-digit group of a message, in order, without duplicates. Persian and Arabic digits count, zero-width and
// direction marks are dropped, other words around the code do not matter.
export function extractCodes(message) {
  const text = normalizeDigits(String(message ?? '').slice(0, INBOUND_MAX_MESSAGE_CHARS)).replace(INVISIBLE, '').replace(/\s+/g, ' ');
  const found = [];
  for (const match of text.matchAll(/(?<!\d)\d{6}(?!\d)/g)) {
    if (!found.includes(match[0])) found.push(match[0]);
    if (found.length >= INBOUND_MAX_CODES_PER_MESSAGE) break;
  }
  return found;
}

// An IP as the proxy handling reports it: IPv4-mapped IPv6 («::ffff:1.2.3.4») is the IPv4 address.
export function canonicalIp(value) {
  const text = normalizeDigits(value).trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  const ip = mapped ? mapped[1] : text;
  return net.isIP(ip) ? ip : null;
}

export const parseIpList = (stored) => String(stored ?? '').split(',').map((part) => part.trim()).filter(Boolean);

// Empty list: any address may call (the key is still required).
export function ipAllowed(list, requestIp) {
  if (!list.length) return true;
  const ip = canonicalIp(requestIp ?? '');
  return Boolean(ip) && list.includes(ip);
}

// The address the main admin pastes into ippanel. The @ words are ippanel's own placeholders and must stay as they are.
export const webhookUrl = (publicUrl, key) => `${new URL(publicUrl).origin}/api/reader/auth/sms-in?key=${key}&from=@FROM&to=@TO&message=@MSG`;
