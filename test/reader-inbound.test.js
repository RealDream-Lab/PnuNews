import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { hashInboundCode, hashHandle, canonicalIp, cleanLineSetting, extractCodes, generateInboundKey, inboundBody, normalizeLine, sameSecret, webhookUrl } from '../src/lib/reader-inbound.js';
import { hashOtp } from '../src/lib/reader-auth.js';
import { redactForLog } from '../src/lib/log-redact.js';
import { READER_SETTING_KEYS, readerSettingsFromRows, validateReaderSettingsUpdate } from '../src/lib/reader-settings.js';
import { createPublicRouter } from '../src/routes/public.js';
import { createReaderAdminRouter } from '../src/routes/readers-admin.js';
import { INBOUND_KEY, INBOUND_LINE, RECEIVE_SETTINGS, SECRET, withReaderApp } from './helpers/reader-app.js';

const SAMPLE = { from: '989353300351', to: '985000262720', message: 'تست وب هوک' }; // the provider's real example
const PHONE = '09121234567';
const E164 = '+989121234567';
const receiveApp = (run, options = {}) => withReaderApp({ settings: RECEIVE_SETTINGS, ...options }, run);

// Everything printed while a test runs, to prove that no secret and no full number reaches a log.
async function captureLogs(run) {
  const lines = [];
  const originals = {};
  for (const name of ['log', 'info', 'warn', 'error']) {
    originals[name] = console[name];
    console[name] = (...args) => lines.push(args.map(String).join(' '));
  }
  try { return await run(lines); } finally { Object.assign(console, originals); }
}

// ---------- pure helpers ----------

test('the message: every standalone six-digit group, Persian digits too, other words and invisible marks do not matter', () => {
  assert.deepEqual(extractCodes('کد ورود به اخبار پیام‌نور: 483920'), ['483920']);
  assert.deepEqual(extractCodes('سلام\n  کد ۴۸۳۹۲۰ \u200f  ممنون'), ['483920'], 'Persian digits, white space and direction marks');
  assert.deepEqual(extractCodes('کد: ٤٨٣٩٢٠'), ['483920'], 'Arabic-Indic digits');
  assert.deepEqual(extractCodes('تماس 021234 یا 4839201 یا 48392 و 123456 و 123456'), ['021234', '123456'], 'seven and five digits are not codes; duplicates once; leading zeros stay');
  assert.deepEqual(extractCodes('48\u200c3920'), ['483920'], 'a zero-width character inside the code does not break it');
  assert.deepEqual(extractCodes('تست وب هوک'), []);
  assert.deepEqual(extractCodes(undefined), []);
  assert.equal(extractCodes(Array.from({ length: 40 }, (_, i) => String(100000 + i)).join(' ')).length, 10, 'a message cannot make the server try an unbounded number of codes');
});

test('the line: +98…, 0098…, 0… and plain digits are the same line; the setting is 8 to 14 digits', () => {
  for (const form of ['985000262720', '+985000262720', '00985000262720', '05000262720', '+98 500 026 2720', '۹۸۵۰۰۰۲۶۲۷۲۰']) assert.equal(normalizeLine(form), '985000262720', form);
  assert.equal(normalizeLine('abc'), null);
  assert.equal(normalizeLine(''), null);
  assert.equal(cleanLineSetting('۹۸۵۰۰۰۲۶۲۷۲۰'), '985000262720');
  for (const bad of ['1234567', '123456789012345', '98500x262720', '+985000262720', '']) assert.equal(cleanLineSetting(bad), null, bad);
});

test('the code hash includes the phone and cannot be an ordinary SMS-code hash; secrets compare in constant time', () => {
  const a = hashInboundCode(SECRET, '+989121234567', '483920');
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.notEqual(a, hashInboundCode(SECRET, '+989121234568', '483920'), 'another phone, another hash');
  assert.notEqual(a, hashOtp(SECRET, '+989121234567', '483920'), 'a code of the other method never matches');
  assert.equal(sameSecret(INBOUND_KEY, INBOUND_KEY), true);
  assert.equal(sameSecret(`${INBOUND_KEY}0`, INBOUND_KEY), false);
  assert.equal(sameSecret('', INBOUND_KEY), false);
  assert.equal(sameSecret(INBOUND_KEY, null), false, 'no stored key never matches');
  assert.equal(sameSecret(undefined, INBOUND_KEY), false);
  assert.match(generateInboundKey(), /^[a-f0-9]{64}$/);
  assert.notEqual(generateInboundKey(), generateInboundKey());
  assert.equal(canonicalIp('::ffff:10.0.0.1'), '10.0.0.1');
  assert.equal(canonicalIp('not an ip'), null);
});

test('the webhook address keeps ippanel\'s @ placeholders and the origin of the public URL', () => {
  assert.equal(webhookUrl('https://news.pnu.ac.ir/', 'KEY'), 'https://news.pnu.ac.ir/api/reader/auth/sms-in?key=KEY&from=@FROM&to=@TO&message=@MSG');
  assert.equal(inboundBody('483920'), 'کد ورود به اخبار پیام‌نور: 483920');
});

test('the key never reaches a log line, even inside a URL in an error message', () => {
  const text = redactForLog(`Request failed: GET /api/reader/auth/sms-in?key=${INBOUND_KEY}&from=989353300351&to=985000262720`);
  assert.ok(!text.includes(INBOUND_KEY));
  assert.ok(!text.includes('989353300351'));
  assert.match(text, /key=\[hidden\]/);
  assert.match(redactForLog('x&key=abc;y'), /key=\[hidden\]/);
});

// ---------- settings ----------

test('settings: the method is an enum, the line is digits, the addresses are IPs; anything else is refused, not corrected', () => {
  assert.deepEqual(validateReaderSettingsUpdate({ auth_method: 'sms_receive', inbound_line: '۹۸۵۰۰۰۲۶۲۷۲۰', inbound_ips: ['::ffff:1.2.3.4', '1.2.3.4', '2001:db8::1'] }),
    { ok: true, values: { auth_method: 'sms_receive', inbound_line: '985000262720', inbound_ips: ['1.2.3.4', '2001:db8::1'] } });
  assert.deepEqual(validateReaderSettingsUpdate({ inbound_line: '' }), { ok: true, values: { inbound_line: '' } }, 'an empty line clears it');
  for (const bad of [{ auth_method: 'both' }, { auth_method: 'SMS_SEND' }, { auth_method: true }, { auth_method: null }, { auth_method: ['sms_send'] },
    { inbound_line: '12345' }, { inbound_line: 98500026272 }, { inbound_line: '+985000262720' }, { inbound_line: 'abc' },
    { inbound_ips: '1.2.3.4' }, { inbound_ips: ['999.1.1.1'] }, { inbound_ips: [1] }, { inbound_ips: Array.from({ length: 21 }, (_, i) => `10.0.0.${i + 1}`) },
    { inbound_key: 'a'.repeat(64) }, { reader_inbound_key: 'a'.repeat(64) }]) {
    const answer = validateReaderSettingsUpdate(bad);
    assert.equal(answer.ok, false, JSON.stringify(bad));
    assert.match(answer.error, /[\u0600-\u06ff]/, 'the refusal is in Persian');
  }
});

test('settings: a missing or damaged row means the original method, and the secret key is not a setting at all', () => {
  assert.equal(readerSettingsFromRows([]).auth_method, 'sms_send');
  assert.equal(readerSettingsFromRows([{ k: 'reader_auth_method', v: 'garbage' }]).auth_method, 'sms_send');
  assert.equal(readerSettingsFromRows([{ k: 'reader_auth_method', v: 'sms_receive' }]).auth_method, 'sms_receive');
  assert.deepEqual(readerSettingsFromRows([{ k: 'reader_inbound_ips', v: '1.2.3.4,bogus,::ffff:5.6.7.8' }]).inbound_ips, ['1.2.3.4', '5.6.7.8']);
  assert.ok(!READER_SETTING_KEYS.includes('reader_inbound_key'), 'the key is never loaded with the settings');
  const all = readerSettingsFromRows([{ k: 'reader_inbound_key', v: INBOUND_KEY }]);
  assert.ok(!JSON.stringify(all).includes(INBOUND_KEY));
});

// ---------- the reader's side ----------

test('request-inbound: a challenge with a handle, a code that never starts with 0, the line and the Persian body; only hashes are stored', async () => {
  await receiveApp(async ({ db, requestInbound, fetchImpl, clock }) => {
    const answer = await requestInbound(PHONE);
    assert.equal(answer.status, 200);
    const { ok, handle, code, line, body, expires_in: expiresIn } = answer.json;
    assert.equal(ok, true);
    assert.match(code, /^[1-9]\d{5}$/);
    assert.equal(line, '+985000262720');
    assert.equal(body, `کد ورود به اخبار پیام‌نور: ${code}`);
    assert.equal(expiresIn, 300);
    assert.match(handle, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(db.challenges.length, 1);
    const [row] = db.challenges;
    assert.equal(row.phone, E164);
    assert.equal(row.code_hash, hashInboundCode(SECRET, E164, code));
    assert.equal(row.handle_hash, hashHandle(handle));
    assert.equal(row.expires_at.getTime() - clock.now, 300_000);
    const stored = JSON.stringify(db.challenges);
    assert.ok(!stored.includes(code) && !stored.includes(handle), 'neither the code nor the handle is stored in clear text');
    assert.equal(fetchImpl.calls.filter((call) => call.url.endsWith('/api/send')).length, 0, 'nothing is sent by us and no SMS budget is touched');
    assert.equal(db.smsLog.length, 0);
  });
});

test('request-inbound: bad number, signup off, no line configured', async () => {
  await receiveApp(async ({ requestInbound }) => {
    const bad = await requestInbound('0123');
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, 'badPhone');
  });
  await receiveApp(async ({ requestInbound }) => {
    const off = await requestInbound(PHONE);
    assert.equal(off.status, 403);
    assert.equal(off.json.code, 'disabled');
  }, { settings: { ...RECEIVE_SETTINGS, reader_signup_enabled: '0' } });
  await receiveApp(async ({ requestInbound }) => {
    const none = await requestInbound(PHONE);
    assert.equal(none.status, 503);
    assert.equal(none.json.code, 'inboundDown');
  }, { settings: { reader_signup_enabled: '1', reader_auth_method: 'sms_receive' } });
});

test('the two methods refuse each other: in sms_send the new endpoints and the webhook, in sms_receive the old ones', async () => {
  await withReaderApp({ settings: { reader_signup_enabled: '1', reader_inbound_line: INBOUND_LINE, reader_inbound_key: INBOUND_KEY } }, async ({ db, requestInbound, inboundStatus, sendSms }) => {
    const request = await requestInbound(PHONE);
    assert.equal(request.status, 403);
    assert.equal(request.json.code, 'methodSend');
    assert.match(request.json.error, /[\u0600-\u06ff]/);
    const status = await inboundStatus('a'.repeat(43));
    assert.equal(status.status, 403);
    const hook = await sendSms('کد: 483920');
    assert.equal(hook.status, 200, 'the provider is told «received» so it does not retry');
    assert.equal(hook.text, 'ok');
    assert.equal(db.challenges.length, 0);
    assert.equal(db.inboundLog.at(-1).reason, 'wrong_method');
  });
  await receiveApp(async ({ requestCode, verify, sentCodes, fetchImpl }) => {
    const request = await requestCode(PHONE);
    assert.equal(request.status, 403);
    assert.equal(request.json.code, 'methodReceive');
    const verified = await verify('123456');
    assert.equal(verified.status, 403);
    assert.equal(verified.json.code, 'methodReceive');
    assert.equal(sentCodes().length, 0);
    assert.equal(fetchImpl.calls.length, 0, 'ippanel is never called in sms_receive mode');
  });
});

// ---------- the whole way in ----------

test('the real sample from the provider is received and ignored; then the real message confirms and a new reader gets the signup token', async () => {
  await receiveApp(async ({ db, requestInbound, inboundStatus, hook, signup }) => {
    const sample = await hook(SAMPLE);
    assert.equal(sample.status, 200);
    assert.equal(sample.text, 'ok');
    assert.match(sample.headers['content-type'], /^text\/plain/);
    assert.equal(sample.headers['cache-control'], 'no-store');
    assert.deepEqual(db.inboundLog.map((entry) => entry.reason), ['no_code'], 'the sample has no challenge and no code: ignored');

    const { json } = await requestInbound('09353300351');
    assert.equal((await inboundStatus(json.handle)).json.status, 'waiting');
    const confirmed = await hook({ ...SAMPLE, message: json.body });
    assert.equal(confirmed.status, 200);
    assert.equal(db.inboundLog.at(-1).outcome, 'confirmed');
    assert.equal(db.inboundLog.at(-1).masked_phone, '+98935***0351');

    const status = await inboundStatus(json.handle);
    assert.equal(status.json.status, 'confirmed');
    assert.equal(status.json.needs_signup, true);
    assert.ok(status.json.signup_token);
    assert.ok(!status.cookie, 'a new number has no session yet');
    const signed = await signup(status.json.signup_token);
    assert.equal(signed.status, 201);
    assert.equal(signed.json.user.phone, '+989353300351');
  });
});

test('a known number gets its session straight away, and the same confirmed challenge cannot be used twice', async () => {
  await receiveApp(async ({ db, requestInbound, inboundStatus, sendSms, call, register }) => {
    // The account is made through the original method's helpers (a second app below would not share it), so seed the user directly.
    db.users.push({ id: 7, phone: E164, first_name: 'علی', last_name: 'رضایی', is_student: 0, student_no: null, unit_id: 51 });
    const { json } = await requestInbound(PHONE);
    await sendSms(json.body);
    const status = await inboundStatus(json.handle);
    assert.equal(status.json.status, 'confirmed');
    assert.equal(status.json.user.first_name, 'علی');
    assert.ok(status.cookie, 'the session cookie is set');
    assert.equal((await call('/api/reader/me', { cookie: status.cookie })).json.user.id, 7);
    assert.equal((await inboundStatus(json.handle)).json.status, 'expired', 'consumed: it cannot log in again');
    assert.equal(db.sessions.length, 1);
    assert.equal(typeof register, 'function');
  });
});

test('the message may carry other words, Persian digits, or several numbers; the code is found', async () => {
  await receiveApp(async ({ requestInbound, inboundStatus, sendSms }) => {
    const toPersian = (text) => text.replace(/\d/g, (digit) => '۰۱۲۳۴۵۶۷۸۹'[digit]);
    const cases = [
      (code) => `سلام، لطفاً ورود من را تأیید کنید. کد: ${code} با تشکر`,
      (code) => toPersian(`کد ورود به اخبار پیام‌نور: ${code}`),
      (code) => `تماس 021234 یا 111111 و کد من ${code} و شماره 0912`,
      (code) => `${code}`,
    ];
    for (const make of cases) {
      const { json } = await requestInbound(PHONE);
      await sendSms(make(json.code));
      assert.equal((await inboundStatus(json.handle)).json.status, 'confirmed', make('000000'));
    }
  });
});

test('what is not a match is received and changes nothing: wrong key, no key, wrong line, wrong sender, wrong code', async () => {
  await receiveApp(async ({ db, requestInbound, inboundStatus, sendSms, hook }) => {
    const { json } = await requestInbound(PHONE);
    const before = JSON.stringify(db.challenges);
    const attempts = [
      ['bad_key', () => sendSms(json.body, '989121234567', INBOUND_LINE, { key: 'f'.repeat(64) })],
      ['bad_key', () => sendSms(json.body, '989121234567', INBOUND_LINE, { key: null })],
      ['bad_key', () => sendSms(json.body, '989121234567', INBOUND_LINE, { key: INBOUND_KEY.toUpperCase() })],
      ['wrong_line', () => sendSms(json.body, '989121234567', '985000000000')],
      ['wrong_line', () => hook({ from: '989121234567', message: json.body })],
      ['bad_sender', () => sendSms(json.body, '5000')],
      ['bad_sender', () => sendSms(json.body, 'PNU-NEWS')],
      ['bad_sender', () => sendSms(json.body, '982188776655')],
      ['no_match', () => sendSms(json.body, '989121234999')], // another phone sends the right text
      ['no_match', () => sendSms('کد: 100000')],
      ['no_code', () => sendSms('سلام')],
    ];
    for (const [reason, send] of attempts) {
      const answer = await send();
      assert.equal(answer.status, 200, reason);
      assert.equal(answer.text, 'ok', 'the answer never explains anything');
      assert.equal(JSON.stringify(db.challenges), before, `${reason}: nothing changed`);
    }
    assert.equal((await inboundStatus(json.handle)).json.status, 'waiting');
    const reasons = db.inboundLog.map((entry) => entry.reason);
    for (const reason of ['bad_key', 'wrong_line', 'bad_sender', 'no_match', 'no_code']) assert.ok(reasons.includes(reason), reason);
    assert.equal(db.inboundLog.filter((entry) => entry.reason === 'bad_key').length, 1, 'strangers cannot flood the log: one bad-key line a minute');
  });
});

test('expired, reused and already consumed challenges do not confirm', async () => {
  await receiveApp(async ({ db, clock, requestInbound, inboundStatus, sendSms }) => {
    const late = (await requestInbound(PHONE)).json;
    clock.now += 5 * 60_000; // exactly at expiry
    await sendSms(late.body);
    assert.equal(db.challenges[0].confirmed_at, null, 'at the moment of expiry it is already too late');
    assert.equal((await inboundStatus(late.handle)).json.status, 'expired');

    const once = (await requestInbound(PHONE)).json;
    await sendSms(once.body);
    const first = db.challenges.find((c) => c.handle_hash === hashHandle(once.handle)).confirmed_at;
    clock.now += 30_000;
    await sendSms(once.body); // the same SMS again
    assert.equal(db.challenges.find((c) => c.handle_hash === hashHandle(once.handle)).confirmed_at, first, 'a second SMS does not confirm again');
    assert.equal(db.inboundLog.at(-1).reason, 'no_match');
    assert.equal((await inboundStatus(once.handle)).json.status, 'confirmed');
    await sendSms(once.body); // after it was consumed
    assert.equal(db.inboundLog.at(-1).reason, 'no_match');
  });
});

test('a confirmed challenge can still be picked up for two minutes, then it is gone', async () => {
  await receiveApp(async ({ clock, requestInbound, inboundStatus, sendSms }) => {
    const slow = (await requestInbound(PHONE)).json;
    clock.now += 290_000;
    await sendSms(slow.body); // arrives 10 s before expiry
    clock.now += 100_000; // the poll comes after the five minutes
    assert.equal((await inboundStatus(slow.handle)).json.status, 'confirmed');
    const stale = (await requestInbound(PHONE)).json;
    await sendSms(stale.body);
    clock.now += 121_000;
    assert.equal((await inboundStatus(stale.handle)).json.status, 'expired');
  });
});

test('two phones with the same code: the SMS only ever confirms the challenge of the number it came from', async () => {
  await receiveApp(async ({ db, clock, sendSms, inboundStatus }) => {
    const phoneA = '+989121234567';
    const phoneB = '+989121234568';
    const at = new Date(clock.now);
    const seed = (phone, handle) => db.challenges.push({ id: db.challenges.length + 1, phone, code_hash: hashInboundCode(SECRET, phone, '483920'), handle_hash: hashHandle(handle), ip: null, created_at: at, expires_at: new Date(clock.now + 300_000), confirmed_at: null, consumed_at: null });
    const handleA = 'A'.repeat(43);
    const handleB = 'B'.repeat(43);
    seed(phoneA, handleA);
    seed(phoneB, handleB);
    await sendSms('کد 483920', '989121234568');
    assert.equal((await inboundStatus(handleA)).json.status, 'waiting');
    assert.equal(db.challenges[1].confirmed_at !== null, true);
    assert.equal(db.challenges[0].confirmed_at, null, 'A is untouched by B\'s SMS');
  });
});

test('taking a confirmed challenge is atomic: of two parallel questions exactly one wins and only one session exists', async () => {
  await receiveApp(async ({ db, requestInbound, inboundStatus, sendSms }) => {
    db.users.push({ id: 3, phone: E164, first_name: 'سارا', last_name: 'احمدی', is_student: 0, student_no: null, unit_id: 51 });
    const { json } = await requestInbound(PHONE);
    await sendSms(json.body);
    const answers = await Promise.all([inboundStatus(json.handle), inboundStatus(json.handle), inboundStatus(json.handle)]);
    assert.deepEqual(answers.map((answer) => answer.json.status).sort(), ['confirmed', 'expired', 'expired']);
    assert.equal(db.sessions.length, 1);
  });
});

test('a challenge belongs to the browser that made it: another handle, a guessed handle or a bad one gets nothing', async () => {
  await receiveApp(async ({ db, requestInbound, inboundStatus, sendSms }) => {
    db.users.push({ id: 3, phone: E164, first_name: 'سارا', last_name: 'احمدی', is_student: 0, student_no: null, unit_id: 51 });
    const mine = (await requestInbound(PHONE)).json;
    const theirs = (await requestInbound('09121234000')).json; // another reader, another handle
    await sendSms(mine.body);
    for (const handle of [theirs.handle, 'x'.repeat(43), hashHandle(mine.handle).slice(0, 43)]) {
      const answer = await inboundStatus(handle);
      assert.notEqual(answer.json?.status, 'confirmed', 'only the handle of the browser that asked can take it');
      assert.ok(!answer.cookie);
    }
    for (const bad of [undefined, '', 'short', 123, ['a'.repeat(43)], 'a'.repeat(44), `${'a'.repeat(42)}!`]) {
      const answer = await inboundStatus(bad);
      assert.equal(answer.status, 400, String(bad));
      assert.equal(answer.json.code, 'badHandle');
    }
    assert.equal((await inboundStatus(mine.handle)).json.status, 'confirmed');
  });
});

test('a new request for the same number cancels the older ones, also one that was confirmed but never taken', async () => {
  await receiveApp(async ({ db, requestInbound, inboundStatus, sendSms }) => {
    const first = (await requestInbound(PHONE)).json;
    const second = (await requestInbound(PHONE)).json;
    assert.equal((await inboundStatus(first.handle)).json.status, 'expired');
    await sendSms(first.body);
    assert.equal(db.challenges.filter((c) => c.confirmed_at).length, 0, 'the old code no longer confirms anything');
    await sendSms(second.body);
    const third = (await requestInbound(PHONE)).json;
    assert.equal((await inboundStatus(second.handle)).json.status, 'expired', 'confirmed but never taken, then replaced');
    assert.equal((await inboundStatus(third.handle)).json.status, 'waiting');
  });
});

test('limits: per number and per address in an hour, and a cap on open challenges; no SMS budget check applies', async () => {
  await receiveApp(async ({ requestInbound, clock }) => {
    for (let i = 0; i < 10; i += 1) assert.equal((await requestInbound(PHONE)).status, 200, `request ${i + 1}`);
    const limited = await requestInbound(PHONE);
    assert.equal(limited.status, 429);
    assert.equal(limited.json.code, 'phoneLimit');
    assert.match(limited.json.error, /[\u0600-\u06ff]/);
    assert.equal((await requestInbound('09120000001')).status, 200, 'another number is not affected');
    clock.now += 61 * 60_000;
    assert.equal((await requestInbound(PHONE)).status, 200, 'an hour later it works again');
  });
  await receiveApp(async ({ db, clock, requestInbound }) => {
    for (let i = 0; i < 60; i += 1) db.challenges.push({ id: 1000 + i, phone: `+98912000${String(1000 + i)}`, code_hash: 'x', handle_hash: String(i).padStart(64, '0'), ip: '127.0.0.1', created_at: new Date(clock.now - 60_000), expires_at: new Date(clock.now - 1), confirmed_at: null, consumed_at: null });
    const limited = await requestInbound(PHONE);
    assert.equal(limited.status, 429);
    assert.equal(limited.json.code, 'ipLimit');
  });
  await receiveApp(async ({ db, clock, requestInbound }) => {
    for (let i = 0; i < 3; i += 1) db.challenges.push({ id: 2000 + i, phone: E164, code_hash: 'x', handle_hash: String(i).padStart(64, 'f'), ip: '10.9.9.9', created_at: new Date(clock.now - 1000), expires_at: new Date(clock.now + 100_000), confirmed_at: null, consumed_at: null });
    const limited = await requestInbound(PHONE);
    assert.equal(limited.status, 429);
    assert.equal(limited.json.code, 'openLimit');
  });
});

test('housekeeping: every new request removes old challenges and old log lines', async () => {
  await receiveApp(async ({ db, clock, requestInbound }) => {
    const day = 24 * 60 * 60_000;
    db.challenges.push({ id: 900, phone: '+989120000009', code_hash: 'x', handle_hash: '9'.repeat(64), ip: null, created_at: new Date(clock.now - 3 * day), expires_at: new Date(clock.now - 2 * day), confirmed_at: null, consumed_at: null });
    db.inboundLog.push({ id: 900, masked_phone: null, ip: null, outcome: 'ignored', reason: 'no_code', created_at: new Date(clock.now - 40 * day) });
    await requestInbound(PHONE);
    assert.equal(db.challenges.some((c) => c.id === 900), false);
    assert.equal(db.inboundLog.length, 0);
  });
});

// ---------- the webhook ----------

test('the webhook also takes POST with a form body; other methods are refused without explanation', async () => {
  await receiveApp(async ({ db, requestInbound, hook, call }) => {
    const { json } = await requestInbound(PHONE);
    const posted = await hook({ from: '989121234567', to: INBOUND_LINE, message: json.body }, { method: 'POST' });
    assert.equal(posted.status, 200);
    assert.equal(db.challenges[0].confirmed_at !== null, true);
    const put = await call(`/api/reader/auth/sms-in?key=${INBOUND_KEY}`, { method: 'PUT', body: {} });
    assert.equal(put.status, 405);
    assert.equal(put.text, 'error');
  });
});

test('the webhook works without cookies or an origin, answers in plain text, and never caches', async () => {
  await receiveApp(async ({ call, requestInbound, hook }) => {
    const { json } = await requestInbound(PHONE);
    const answer = await hook({ from: '989121234567', to: '+985000262720', message: json.body });
    assert.match(answer.headers['content-type'], /^text\/plain/);
    assert.equal(answer.headers['cache-control'], 'no-store');
    assert.equal(answer.headers['set-cookie'], undefined);
    assert.equal(answer.json, null);
    const broken = await call('/api/reader/auth/sms-in', { method: 'POST', body: { x: 1 }, headers: { 'content-type': 'application/json' } });
    assert.equal(broken.status, 200, 'even a call it cannot use is answered the same way');
  });
});

test('only the allowed addresses may call when a list is set (behind the trusted proxy); an empty list allows any', async () => {
  const settings = { ...RECEIVE_SETTINGS, reader_inbound_ips: '10.1.1.1,10.1.1.2' };
  await withReaderApp({ settings, configOverrides: { trustProxy: true } }, async ({ db, requestInbound, sendSms }) => {
    const { json } = await requestInbound(PHONE);
    await sendSms(json.body, '989121234567', INBOUND_LINE, { ip: '10.9.9.9' });
    assert.equal(db.challenges[0].confirmed_at, null);
    assert.equal(db.inboundLog.at(-1).reason, 'ip_blocked');
    await sendSms(json.body, '989121234567', INBOUND_LINE, { ip: '10.1.1.2' });
    assert.notEqual(db.challenges[0].confirmed_at, null);
  });
  await withReaderApp({ settings: RECEIVE_SETTINGS, configOverrides: { trustProxy: true } }, async ({ db, requestInbound, sendSms }) => {
    const { json } = await requestInbound(PHONE);
    await sendSms(json.body, '989121234567', INBOUND_LINE, { ip: '203.0.113.5' });
    assert.notEqual(db.challenges[0].confirmed_at, null);
  });
});

test('the webhook has its own limits: per address, and one for everyone together; the web login limit is not used up by it', async () => {
  await receiveApp(async ({ sendSms, call }) => {
    for (let i = 0; i < 120; i += 1) assert.equal((await sendSms('سلام')).status, 200);
    const limited = await sendSms('سلام');
    assert.equal(limited.status, 429);
    assert.match(limited.headers['content-type'], /^text\/plain/);
    assert.equal(limited.text, 'error');
    assert.equal((await call('/api/reader/auth/inbound-status', { method: 'POST', body: { handle: 'a'.repeat(43) } })).status, 200, 'the readers\' own calls are separate');
  });
  await withReaderApp({ settings: RECEIVE_SETTINGS, configOverrides: { trustProxy: true } }, async ({ sendSms }) => {
    let refused = 0;
    for (let i = 0; i < 640; i += 1) {
      const answer = await sendSms('سلام', '989121234567', INBOUND_LINE, { ip: `10.${i % 250}.${Math.floor(i / 250)}.1` });
      if (answer.status === 429) refused += 1;
    }
    assert.equal(refused, 40, 'a global ceiling of 600 a minute, whoever calls');
  });
});

test('waiting browsers may ask often: the status question has a limit of its own, far above the login limit', async () => {
  await receiveApp(async ({ requestInbound, inboundStatus }) => {
    const { json } = await requestInbound(PHONE);
    for (let i = 0; i < 100; i += 1) assert.equal((await inboundStatus(json.handle)).status, 200, `poll ${i + 1}`);
  });
});

// ---------- nothing secret leaks ----------

test('the key, the code, the handle and the full number never appear in the logs, the log table or the audit', async () => {
  await captureLogs(async (lines) => {
    await receiveApp(async ({ db, call, requestInbound, inboundStatus, sendSms, hook }) => {
      const { json } = await requestInbound(PHONE);
      await hook({ from: '989121234567', to: INBOUND_LINE, message: json.body }, { key: 'e'.repeat(64) });
      await sendSms('تست');
      await sendSms(json.body);
      await inboundStatus(json.handle);
      await call('/api/reader/auth/sms-in', { method: 'POST', body: {}, headers: { 'content-type': 'application/json' } });
      const everything = [...lines, JSON.stringify(db.inboundLog), JSON.stringify(db.audit), JSON.stringify(db.statements.filter((s) => /INSERT INTO reader_inbound_log/.test(s)))].join('\n');
      for (const secret of [INBOUND_KEY, 'e'.repeat(64), json.code, json.handle, '9121234567', INBOUND_LINE]) assert.ok(!everything.includes(secret), `leaked: ${secret.slice(0, 6)}…`);
      assert.ok(db.inboundLog.every((entry) => entry.masked_phone === null || /^\+98912\*\*\*4567$/.test(entry.masked_phone)));
    });
  });
});


test('the public config carries the method and nothing secret; a missing or damaged value means sms_send', async () => {
  const settings = new Map(Object.entries({ reader_signup_enabled: '1', reader_auth_method: 'sms_receive', reader_inbound_line: INBOUND_LINE, reader_inbound_key: INBOUND_KEY, reader_inbound_ips: '1.2.3.4' }));
  const pool = { query: async (sql) => (/FROM settings/.test(sql) ? [[...settings].map(([k, v]) => ({ k, v })), []] : [[], []]) };
  const events = new EventEmitter();
  const app = express();
  app.use(createPublicRouter({ pool, config: { publicUrl: 'https://news.example.ir' }, events, staticAssets: null }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const get = () => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/public/config' }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ text, json: JSON.parse(text), headers: res.headers }));
    }).on('error', reject);
  });
  try {
    const on = await get();
    assert.deepEqual(on.json.reader, { signup_enabled: true, auth_method: 'sms_receive' });
    for (const secret of [INBOUND_KEY, INBOUND_LINE, '1.2.3.4']) assert.ok(!on.text.includes(secret) && !JSON.stringify(on.headers).includes(secret), 'the public config holds no key, line or address');
    for (const bad of ['', 'garbage', 'SMS_RECEIVE']) {
      settings.set('reader_auth_method', bad);
      events.emit('settings.changed');
      assert.equal((await get()).json.reader.auth_method, 'sms_send', `«${bad}»`);
    }
    settings.delete('reader_auth_method');
    events.emit('settings.changed');
    assert.equal((await get()).json.reader.auth_method, 'sms_send');
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
});

// ---------- the main admin's side ----------

// A small database for the admin routes: settings, the audit log and the inbound log, with the two ways the router talks to it.
function adminDatabase(initial = {}) {
  const settings = new Map(Object.entries(initial));
  const audit = [];
  const inboundLog = [];
  const answer = async (sql, params = []) => {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT k, v FROM settings WHERE k IN \(\?\)$/.test(text)) return [[...settings].filter(([k]) => params[0].includes(k)).map(([k, v]) => ({ k, v })), []];
    if (/^INSERT INTO settings/.test(text)) { settings.set(params[0], params[1]); return [{}, []]; }
    if (/^DELETE FROM settings/.test(text)) { settings.delete(params[0]); return [{}, []]; }
    if (/^INSERT INTO audit_log/.test(text)) { audit.push({ action: params[1], meta: JSON.parse(params[2]) }); return [{}, []]; }
    if (/FROM reader_inbound_log/.test(text)) return [inboundLog, []];
    throw new Error(`unhandled SQL: ${text}`);
  };
  const connection = { query: answer, execute: answer, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {} };
  return { pool: { query: answer, execute: answer, getConnection: async () => connection }, settings, audit, inboundLog };
}

async function adminApp(user, database, run) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = user; next(); });
  const events = new EventEmitter();
  const heard = [];
  events.on('settings.changed', () => heard.push('changed'));
  app.use('/api/admin/readers', createReaderAdminRouter({ pool: database.pool, config: { publicUrl: 'https://news.pnu.ac.ir' }, events }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const call = (path, { method = 'GET', body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method, headers: body ? { 'content-type': 'application/json' } : {} }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null, text }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
  try { return await run({ call, heard }); } finally { server.close(); server.closeAllConnections?.(); }
}

const SUPER = { id: 1, role: 'super_admin' };

test('admin: switching to sms_receive needs the line first; the server then makes the key, audits the method change and tells the site', async () => {
  const database = adminDatabase({ reader_signup_enabled: '1' });
  await adminApp(SUPER, database, async ({ call, heard }) => {
    const refused = await call('/api/admin/readers/settings', { method: 'PUT', body: { auth_method: 'sms_receive' } });
    assert.equal(refused.status, 400);
    assert.match(refused.json.error, /شمارهٔ خط دریافت/);
    assert.equal(database.settings.get('reader_auth_method'), undefined, 'nothing was written');

    const put = await call('/api/admin/readers/settings', { method: 'PUT', body: { auth_method: 'sms_receive', inbound_line: '۹۸۵۰۰۰۲۶۲۷۲۰', inbound_ips: ['1.2.3.4'] } });
    assert.equal(put.status, 200);
    assert.equal(put.json.settings.auth_method, 'sms_receive');
    assert.equal(put.json.settings.inbound_line, '985000262720');
    assert.deepEqual(put.json.settings.inbound_ips, ['1.2.3.4']);
    assert.match(database.settings.get('reader_inbound_key'), /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(put.json).includes(database.settings.get('reader_inbound_key')), 'the answer does not carry the key');
    assert.deepEqual(heard, ['changed']);
    assert.deepEqual(database.audit.map((entry) => entry.action), ['reader.auth_method.change', 'reader.settings.update']);
    assert.deepEqual(database.audit[0].meta, { from: 'sms_send', to: 'sms_receive', key_generated: true });
    assert.ok(!JSON.stringify(database.audit).includes(database.settings.get('reader_inbound_key')), 'the key is not in the event log');

    const settings = await call('/api/admin/readers/settings');
    assert.ok(!JSON.stringify(settings.json).includes(database.settings.get('reader_inbound_key')));
    const clear = await call('/api/admin/readers/settings', { method: 'PUT', body: { inbound_line: '' } });
    assert.equal(clear.status, 400, 'the line cannot be removed while the method needs it');
    const back = await call('/api/admin/readers/settings', { method: 'PUT', body: { auth_method: 'sms_send' } });
    assert.equal(back.status, 200);
    assert.match(database.settings.get('reader_inbound_key'), /^[a-f0-9]{64}$/, 'the key is kept, so the address in ippanel stays valid');
    assert.equal(database.audit.at(-1).meta.key_generated, false);
  });
});

test('admin: the key cannot be typed, and the settings of the other method are untouched by this one', async () => {
  const database = adminDatabase({ reader_signup_enabled: '1' });
  await adminApp(SUPER, database, async ({ call }) => {
    for (const body of [{ inbound_key: 'a'.repeat(64) }, { reader_inbound_key: 'a'.repeat(64) }, { auth_method: 'sms_receive', inbound_key: 'a'.repeat(64), inbound_line: '985000262720' }]) {
      assert.equal((await call('/api/admin/readers/settings', { method: 'PUT', body })).status, 400);
    }
    assert.equal(database.settings.get('reader_inbound_key'), undefined);
    const same = await call('/api/admin/readers/settings', { method: 'PUT', body: { auth_method: 'sms_send' } });
    assert.equal(same.status, 200);
    assert.equal(database.audit.length, 0, 'no change, no event');
  });
});

test('admin: the webhook address (with the key) and the recent events are the main admin\'s alone', async () => {
  const database = adminDatabase({ reader_inbound_key: INBOUND_KEY });
  database.inboundLog.push({ masked_phone: '+98912***4567', ip: '1.2.3.4', outcome: 'ignored', reason: 'wrong_line', created_at: new Date(Date.UTC(2026, 10, 24)) });
  await adminApp(SUPER, database, async ({ call }) => {
    const answer = await call('/api/admin/readers/inbound');
    assert.equal(answer.status, 200);
    assert.equal(answer.json.webhook_url, `https://news.pnu.ac.ir/api/reader/auth/sms-in?key=${INBOUND_KEY}&from=@FROM&to=@TO&message=@MSG`);
    assert.deepEqual(answer.json.recent, [{ phone: '+98912***4567', ip: '1.2.3.4', outcome: 'ignored', reason: 'wrong_line', at: '2026-11-24T00:00:00.000Z' }]);
  });
  for (const role of ['province_admin', 'city_admin', 'country_admin']) {
    await adminApp({ id: 2, role }, database, async ({ call }) => {
      assert.equal((await call('/api/admin/readers/inbound')).status, 403, role);
      assert.equal((await call('/api/admin/readers/inbound-key', { method: 'POST', body: {} })).status, 403, role);
    });
  }
  await adminApp(SUPER, adminDatabase(), async ({ call }) => {
    assert.equal((await call('/api/admin/readers/inbound')).json.webhook_url, null, 'no key yet, no address');
  });
});

test('admin: a new key replaces the old one at once, and the event log never sees either', async () => {
  const database = adminDatabase({ reader_inbound_key: INBOUND_KEY, reader_signup_enabled: '1', reader_auth_method: 'sms_receive', reader_inbound_line: INBOUND_LINE });
  await adminApp(SUPER, database, async ({ call }) => {
    const rotated = await call('/api/admin/readers/inbound-key', { method: 'POST', body: {} });
    assert.equal(rotated.status, 200);
    const fresh = database.settings.get('reader_inbound_key');
    assert.match(fresh, /^[a-f0-9]{64}$/);
    assert.notEqual(fresh, INBOUND_KEY);
    assert.equal(rotated.json.webhook_url, `https://news.pnu.ac.ir/api/reader/auth/sms-in?key=${fresh}&from=@FROM&to=@TO&message=@MSG`);
    assert.deepEqual(database.audit, [{ action: 'reader.inbound_key.rotate', meta: {} }]);
  });
  // The old address stops working: the webhook reads the stored key on every call.
  await withReaderApp({ settings: { ...RECEIVE_SETTINGS, reader_inbound_key: 'c'.repeat(64) } }, async ({ db, requestInbound, sendSms }) => {
    const { json } = await requestInbound(PHONE);
    await sendSms(json.body, '989121234567', INBOUND_LINE, { key: INBOUND_KEY });
    assert.equal(db.challenges[0].confirmed_at, null, 'the old key confirms nothing');
    await sendSms(json.body, '989121234567', INBOUND_LINE, { key: 'c'.repeat(64) });
    assert.notEqual(db.challenges[0].confirmed_at, null);
  });
});
