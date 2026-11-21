import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { cleanFaText } from './fa.js';

export const OTP_LENGTH = 6;
export const OTP_TTL_MS = 3 * 60_000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_GAP_MS = 60_000;
export const SIGNUP_TOKEN_TTL_MS = 10 * 60_000;

// Persian (۰-۹) and Arabic-Indic (٠-٩) digits to ASCII.
export function normalizeDigits(value) {
  return String(value ?? '')
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660));
}

// Any usual way of writing an Iranian mobile number to +989123456789, or null when it is not one.
export function normalizePhone(value) {
  let digits = normalizeDigits(value).replace(/[\s\-().\u200c\u200e\u200f]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('00')) digits = digits.slice(2);
  if (!/^\d+$/.test(digits)) return null;
  if (digits.length === 12 && digits.startsWith('98')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^9\d{9}$/.test(digits) ? `+98${digits}` : null;
}

// For the SMS log and the admin panel: the number without its middle.
export function maskPhone(phone) {
  return `${phone.slice(0, 6)}***${phone.slice(-4)}`;
}

// A person's first or last name: letters (any script), spaces, half-spaces, hyphen, apostrophe, dot; 2 to 60 characters; no digits.
export function cleanPersonName(value) {
  const text = cleanFaText(value);
  if (text.length < 2 || text.length > 60) return null;
  return /^[\p{L}\p{M}][\p{L}\p{M} \u200c'’.-]*$/u.test(text) ? text : null;
}

export function cleanStudentNumber(value) {
  const digits = normalizeDigits(value).trim();
  return /^\d{6,14}$/.test(digits) ? digits : null;
}

export function cleanOtpInput(value) {
  const digits = normalizeDigits(value).replace(/\s/g, '');
  return new RegExp(`^\\d{${OTP_LENGTH}}$`).test(digits) ? digits : null;
}

// Never starts with 0: the pattern's variable is a number type, and a number would lose its leading zero.
export const generateOtp = () => String(randomInt(10 ** (OTP_LENGTH - 1), 10 ** OTP_LENGTH));

// Only this hash is stored. It includes the phone number, so a hash cannot be reused for another number.
export function hashOtp(secret, phone, code) {
  return createHmac('sha256', secret).update(`reader-otp:${phone}:${code}`).digest('hex');
}

export function sameHex(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

// Proof that this browser verified this number a moment ago, so the signup form can be sent without asking for a second code.
export function signSignupToken(secret, phone, now) {
  const payload = Buffer.from(JSON.stringify({ p: phone, e: now + SIGNUP_TOKEN_TTL_MS })).toString('base64url');
  const signature = createHmac('sha256', secret).update(`reader-signup:${payload}`).digest('hex');
  return `${payload}.${signature}`;
}

export function readSignupToken(secret, token, now) {
  if (typeof token !== 'string' || token.length > 400) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  const expected = createHmac('sha256', secret).update(`reader-signup:${payload}`).digest('hex');
  if (!sameHex(signature, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof parsed.p === 'string' && Number.isFinite(parsed.e) && parsed.e > now ? { phone: parsed.p } : null;
  } catch {
    return null;
  }
}
