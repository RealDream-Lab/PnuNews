import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  base32Decode,
  base32Encode,
  consumeBackupCode,
  decryptTotpSecret,
  encryptTotpSecret,
  generateBackupCodes,
  generateTotp,
  hashBackupCode,
  hashPassword,
  verifyPassword,
  verifyTotp,
} from '../src/auth/crypto.js';

test('Base32 follows RFC 4648 encoding and decoding', () => {
  const vectors = [
    ['', ''],
    ['f', 'MY======'],
    ['fo', 'MZXQ===='],
    ['foo', 'MZXW6==='],
    ['foob', 'MZXW6YQ='],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI======'],
  ];
  for (const [plain, encoded] of vectors) {
    assert.equal(base32Encode(Buffer.from(plain)), encoded);
    assert.equal(base32Decode(encoded).toString(), plain);
    assert.equal(base32Decode(encoded.replace(/=+$/, '').toLowerCase()).toString(), plain);
  }
  assert.throws(() => base32Decode('MZ======'), /trailing bits/);
  assert.throws(() => base32Decode('MZXW6YQ==='), /padding/);
});

test('TOTP matches RFC 6238 Appendix B SHA-1 vectors with configurable digits', () => {
  const secret = Buffer.from('12345678901234567890');
  const vectors = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  for (const [seconds, expected] of vectors) {
    assert.equal(generateTotp(secret, { time: seconds * 1000, digits: 8 }), expected);
  }
});

test('TOTP defaults to six digits and verifies a ±1 window without replay', () => {
  const secret = Buffer.from('test shared secret');
  const time = 90_000;
  const current = generateTotp(secret, { time });
  const previous = generateTotp(secret, { time: 60_000 });
  assert.match(current, /^\d{6}$/);
  assert.equal(verifyTotp(current, secret, { time }), 3);
  assert.equal(verifyTotp(previous, secret, { time }), 2);
  assert.equal(verifyTotp(previous, secret, { time, lastStep: 2 }), null);
  assert.equal(verifyTotp(current, secret, { time, lastStep: 3 }), null);
  assert.equal(verifyTotp('invalid', secret, { time }), null);
});

test('TOTP secret encryption uses an authenticated, versioned envelope', () => {
  const appSecret = 'a'.repeat(64);
  const encrypted = encryptTotpSecret('JBSWY3DPEHPK3PXP', appSecret);
  assert.match(encrypted, /^v1\./);
  assert.notEqual(encryptTotpSecret('JBSWY3DPEHPK3PXP', appSecret), encrypted);
  assert.equal(decryptTotpSecret(encrypted, appSecret), 'JBSWY3DPEHPK3PXP');
  assert.throws(() => decryptTotpSecret(encrypted, 'b'.repeat(64)));
  const parts = encrypted.split('.');
  parts[3] = `${parts[3][0] === 'A' ? 'B' : 'A'}${parts[3].slice(1)}`;
  assert.throws(() => decryptTotpSecret(parts.join('.'), appSecret));
});

test('password hashes use unique salts and verify asynchronously', async () => {
  const [first, second] = await Promise.all([
    hashPassword('correct horse battery staple'),
    hashPassword('correct horse battery staple'),
  ]);
  assert.match(first, /^scrypt\$16384\$8\$1\$/);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword('correct horse battery staple', first), true);
  assert.equal(await verifyPassword('wrong password', first), false);
  assert.equal(await verifyPassword('correct horse battery staple', 'invalid'), false);
});

test('backup codes are random, stored as SHA-256 hashes, and consumed once', () => {
  const { codes, hashes } = generateBackupCodes();
  assert.equal(codes.length, 10);
  assert.equal(hashes.length, 10);
  assert.equal(new Set(codes).size, 10);
  assert.match(codes[0], /^[A-F0-9]{4}(?:-[A-F0-9]{4}){3}$/);
  assert.deepEqual(hashes, codes.map((code) => createHash('sha256')
    .update(code.replaceAll('-', ''))
    .digest('hex')));

  const storedHashes = [...hashes];
  assert.equal(consumeBackupCode(codes[0].toLowerCase(), storedHashes), true);
  assert.equal(storedHashes.length, 9);
  assert.equal(consumeBackupCode(codes[0], storedHashes), false);
  assert.equal(consumeBackupCode('not-a-code', storedHashes), false);
  assert.equal(hashBackupCode(codes[1]), hashes[1]);
});
