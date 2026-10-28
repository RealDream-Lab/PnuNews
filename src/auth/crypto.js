import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PASSWORD_SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, keyLength: 64 });
const BACKUP_CODE_COUNT = 10;

function requireString(value, name) {
  if (typeof value !== 'string') {
    throw new TypeError(`${name} must be a string`);
  }
}

function normalizeBase32(value) {
  requireString(value, 'Base32 input');
  const normalized = value.toUpperCase();
  if (!/^[A-Z2-7]*={0,6}$/.test(normalized)) {
    throw new TypeError('Invalid Base32 input');
  }
  const unpadded = normalized.replace(/=+$/, '');
  const remainder = unpadded.length % 8;
  if (![0, 2, 4, 5, 7].includes(remainder)) {
    throw new TypeError('Invalid Base32 length');
  }
  const paddingLength = normalized.length - unpadded.length;
  const expectedPadding = remainder === 0 ? 0 : 8 - remainder;
  if (paddingLength && paddingLength !== expectedPadding) {
    throw new TypeError('Invalid Base32 padding');
  }
  return unpadded;
}

export function base32Encode(value) {
  if (!(Buffer.isBuffer(value) || value instanceof Uint8Array)) {
    throw new TypeError('Base32 input must be a Buffer or Uint8Array');
  }

  let bits = 0;
  let bitCount = 0;
  let encoded = '';
  for (const byte of value) {
    bits = (bits << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      encoded += BASE32_ALPHABET[(bits >> bitCount) & 31];
    }
  }
  if (bitCount) {
    encoded += BASE32_ALPHABET[(bits << (5 - bitCount)) & 31];
  }
  if (encoded.length) {
    encoded = encoded.padEnd(Math.ceil(encoded.length / 8) * 8, '=');
  }
  return encoded;
}

export function base32Decode(value) {
  const normalized = normalizeBase32(value);
  const decoded = [];
  let bits = 0;
  let bitCount = 0;

  for (const character of normalized) {
    bits = (bits << 5) | BASE32_ALPHABET.indexOf(character);
    bitCount += 5;
    if (bitCount >= 8) {
      bitCount -= 8;
      decoded.push((bits >> bitCount) & 0xff);
    }
  }

  if (bitCount && (bits & ((1 << bitCount) - 1)) !== 0) {
    throw new TypeError('Invalid Base32 trailing bits');
  }
  return Buffer.from(decoded);
}

export async function hashPassword(password) {
  requireString(password, 'Password');
  const salt = randomBytes(16);
  const derivedKey = await scryptAsync(password, salt, PASSWORD_SCRYPT.keyLength, {
    N: PASSWORD_SCRYPT.N,
    r: PASSWORD_SCRYPT.r,
    p: PASSWORD_SCRYPT.p,
    maxmem: 64 * 1024 * 1024,
  });
  return [
    'scrypt',
    PASSWORD_SCRYPT.N,
    PASSWORD_SCRYPT.r,
    PASSWORD_SCRYPT.p,
    salt.toString('hex'),
    Buffer.from(derivedKey).toString('hex'),
  ].join('$');
}

export async function verifyPassword(password, encodedHash) {
  requireString(password, 'Password');
  requireString(encodedHash, 'Encoded password hash');
  const parts = encodedHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, nText, rText, pText, saltHex, hashHex] = parts;
  const N = Number(nText);
  const r = Number(rText);
  const p = Number(pText);
  if (
    N !== PASSWORD_SCRYPT.N || r !== PASSWORD_SCRYPT.r || p !== PASSWORD_SCRYPT.p ||
    !/^(?:[a-f\d]{2}){16}$/i.test(saltHex) ||
    !/^(?:[a-f\d]{2}){64}$/i.test(hashHex)
  ) {
    return false;
  }

  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  try {
    const actual = Buffer.from(await scryptAsync(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: 64 * 1024 * 1024,
    }));
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function totpSecretBytes(secret) {
  if (Buffer.isBuffer(secret) || secret instanceof Uint8Array) {
    return Buffer.from(secret);
  }
  requireString(secret, 'TOTP secret');
  return Buffer.from(secret, 'utf8');
}

function validateTotpOptions({ time, digits, period }) {
  if (!Number.isFinite(time) || time < 0) {
    throw new RangeError('TOTP time must be a non-negative timestamp in milliseconds');
  }
  if (!Number.isInteger(digits) || digits < 1 || digits > 10) {
    throw new RangeError('TOTP digits must be an integer from 1 to 10');
  }
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError('TOTP period must be a positive integer');
  }
}

function totpAtStep(secret, step, digits) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', totpSecretBytes(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % (10 ** digits)).padStart(digits, '0');
}

export function generateTotp(secret, options = {}) {
  const { time = Date.now(), digits = 6, period = 30 } = options;
  validateTotpOptions({ time, digits, period });
  const step = Math.floor(time / (period * 1000));
  return totpAtStep(secret, step, digits);
}

export function verifyTotp(token, secret, options = {}) {
  const {
    time = Date.now(),
    digits = 6,
    period = 30,
    window = 1,
    lastStep = -1,
  } = options;
  validateTotpOptions({ time, digits, period });
  if (!Number.isInteger(window) || window < 0) {
    throw new RangeError('TOTP window must be a non-negative integer');
  }
  if (!Number.isSafeInteger(lastStep) || lastStep < -1) {
    throw new RangeError('lastStep must be an integer greater than or equal to -1');
  }
  if (typeof token !== 'string' || !new RegExp(`^\\d{${digits}}$`).test(token)) {
    return null;
  }

  const currentStep = Math.floor(time / (period * 1000));
  const offsets = [0];
  for (let distance = 1; distance <= window; distance += 1) {
    offsets.push(-distance, distance);
  }
  const tokenBytes = Buffer.from(token, 'ascii');
  for (const offset of offsets) {
    const step = currentStep + offset;
    if (step < 0 || step <= lastStep) continue;
    const candidate = Buffer.from(totpAtStep(secret, step, digits), 'ascii');
    if (timingSafeEqual(tokenBytes, candidate)) return step;
  }
  return null;
}

function deriveEncryptionKey(appSecret) {
  requireString(appSecret, 'APP_SECRET');
  if (!appSecret) throw new TypeError('APP_SECRET must not be empty');
  return Buffer.from(hkdfSync(
    'sha256',
    Buffer.from(appSecret, 'utf8'),
    Buffer.from('pnu-news:totp-secret:v1', 'utf8'),
    Buffer.from('aes-256-gcm', 'utf8'),
    32,
  ));
}

export function encryptTotpSecret(secret, appSecret) {
  requireString(secret, 'TOTP secret');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveEncryptionKey(appSecret), nonce);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', nonce.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptTotpSecret(envelope, appSecret) {
  requireString(envelope, 'Encrypted TOTP secret');
  const parts = envelope.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new TypeError('Invalid encrypted TOTP secret format');
  }
  const [, nonceText, tagText, ciphertextText] = parts;
  const isBase64Url = (value) => /^[A-Za-z\d_-]*$/.test(value);
  if (!isBase64Url(nonceText) || !isBase64Url(tagText) || !isBase64Url(ciphertextText)) {
    throw new TypeError('Invalid encrypted TOTP secret encoding');
  }
  const nonce = Buffer.from(nonceText, 'base64url');
  const tag = Buffer.from(tagText, 'base64url');
  const ciphertext = Buffer.from(ciphertextText, 'base64url');
  if (nonce.length !== 12 || tag.length !== 16) {
    throw new TypeError('Invalid encrypted TOTP secret parameters');
  }

  const decipher = createDecipheriv('aes-256-gcm', deriveEncryptionKey(appSecret), nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function hashBackupCode(code) {
  requireString(code, 'Backup code');
  const normalized = code.replace(/[\s-]/g, '').toUpperCase();
  if (!normalized) throw new TypeError('Backup code must not be empty');
  return createHash('sha256').update(normalized).digest('hex');
}

export function generateBackupCodes() {
  const codes = Array.from({ length: BACKUP_CODE_COUNT }, () => {
    const value = randomBytes(8).toString('hex').toUpperCase();
    return value.match(/.{4}/g).join('-');
  });
  return { codes, hashes: codes.map(hashBackupCode) };
}

export function consumeBackupCode(code, hashes) {
  requireString(code, 'Backup code');
  if (!Array.isArray(hashes)) throw new TypeError('Backup code hashes must be an array');
  const actual = Buffer.from(hashBackupCode(code), 'hex');
  let matchedIndex = -1;
  for (let index = 0; index < hashes.length; index += 1) {
    const value = hashes[index];
    if (typeof value !== 'string' || !/^(?:[a-f\d]{2}){32}$/i.test(value)) continue;
    const expected = Buffer.from(value, 'hex');
    if (timingSafeEqual(actual, expected) && matchedIndex === -1) matchedIndex = index;
  }
  if (matchedIndex === -1) return false;
  hashes.splice(matchedIndex, 1);
  return true;
}
