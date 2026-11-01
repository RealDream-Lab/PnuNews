import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptSecret, encryptSecret } from '../src/auth/crypto.js';
import { loadConfig } from '../src/config.js';
import { TelegramError, createTelegramClient, describeTelegramError, parseChannelRef } from '../src/lib/telegram.js';
import { buildCaption, buttonLabel, channelsForNews, failureKind, newsUrl, retryDelaySeconds, textHash } from '../src/telegram-publisher.js';

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createProxyFetch, parseProxyUrl } from '../src/lib/http-proxy-fetch.js';

const SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

test('channel references are normalized and junk is rejected', () => {
  assert.equal(parseChannelRef('@my_channel'), '@my_channel');
  assert.equal(parseChannelRef('my_channel'), '@my_channel');
  assert.equal(parseChannelRef('https://t.me/my_channel'), '@my_channel');
  assert.equal(parseChannelRef('t.me/my_channel/'), '@my_channel');
  assert.equal(parseChannelRef('-1001234567890'), '-1001234567890');
  for (const bad of ['', 'ab', '@1abcde', 'http://evil.example/x', '12345', 'a b c d e', null, 5]) assert.equal(parseChannelRef(bad), null);
});

test('the caption is a bold title, a blank line and the plain summary, escaped for Telegram HTML', () => {
  assert.equal(buildCaption({ title: 'عنوان', summary: 'چکیده' }), '<b>عنوان</b>\n\nچکیده');
  assert.equal(buildCaption({ title: 'a < b & c', summary: '<x>' }), '<b>a &lt; b &amp; c</b>\n\n&lt;x&gt;');
  assert.equal(buildCaption({ title: 'فقط عنوان', summary: '  ' }), '<b>فقط عنوان</b>');
  const long = buildCaption({ title: 'ع'.repeat(200), summary: 'چ'.repeat(900) });
  const visible = long.replace(/<[^>]+>/g, '');
  assert.ok(visible.length <= 1024, `caption has ${visible.length} visible characters`);
  assert.ok(visible.endsWith('…'));
});

test('button label, link and content hash', () => {
  assert.equal(buttonLabel('news'), 'مشاهدهٔ خبر');
  assert.equal(buttonLabel('announcement'), 'مشاهدهٔ اطلاعیه');
  assert.equal(newsUrl('https://news.example.ir/', 42), 'https://news.example.ir/n/42');
  const base = { title: 'a', summary: 'b', newsType: 'news', url: 'u' };
  assert.equal(textHash(base), textHash({ ...base }));
  for (const change of [{ title: 'x' }, { summary: 'x' }, { newsType: 'announcement' }, { url: 'x' }]) assert.notEqual(textHash(base), textHash({ ...base, ...change }));
});

test('delivery is retried without limit: at once for outages, a little later for permission and request problems', () => {
  assert.equal(retryDelaySeconds('transient'), 0);
  assert.equal(retryDelaySeconds('access'), 30);
  assert.equal(retryDelaySeconds('other'), 60);
  assert.equal(failureKind(new TelegramError('x', { network: true })), 'transient');
  assert.equal(failureKind(new TelegramError('Bad Gateway', { code: 502 })), 'transient');
  assert.equal(failureKind(new TelegramError('Unauthorized', { code: 401 })), 'access');
  assert.equal(failureKind(new TelegramError('Forbidden', { code: 403 })), 'access');
  assert.equal(failureKind(new TelegramError('Bad Request: chat not found', { code: 400 })), 'access');
  assert.equal(failureKind(new TelegramError('Bad Request: wrong file', { code: 400 })), 'other');
  assert.equal(failureKind(new Error('boom')), 'other');
});

test('a channel gets the news of its own unit and of the units above it, never of those below', () => {
  const regions = [
    { id: 1, parent_id: null }, { id: 2, parent_id: 1 }, { id: 3, parent_id: 1 }, { id: 4, parent_id: 2 }, { id: 5, parent_id: 3 },
  ];
  const channels = [
    { user_id: 10, region_id: 1, chat_id: 'c-country' },
    { user_id: 11, region_id: 2, chat_id: 'c-province' },
    { user_id: 12, region_id: 4, chat_id: 'c-city' },
    { user_id: 13, region_id: 5, chat_id: 'c-other-city' },
  ];
  const ids = (targetIds) => channelsForNews({ targetIds, regions, channels }).map((channel) => channel.user_id);
  assert.deepEqual(ids([1]), [10, 11, 12, 13], 'country news reaches everybody');
  assert.deepEqual(ids([2]), [11, 12], 'province news: that province and its cities');
  assert.deepEqual(ids([4]), [12], 'city news: only that city');
  assert.deepEqual(ids([3, 4]), [12, 13], 'several targets add up');
  assert.deepEqual(ids([]), []);
});

test('two users sharing one chat receive a single message', () => {
  const regions = [{ id: 1, parent_id: null }, { id: 2, parent_id: 1 }];
  const channels = [{ user_id: 7, region_id: 2, chat_id: 'same' }, { user_id: 5, region_id: 1, chat_id: 'same' }];
  assert.deepEqual(channelsForNews({ targetIds: [1], regions, channels }).map((channel) => channel.user_id), [5]);
});

test('secrets are encrypted per purpose and cannot be opened with another purpose or secret', () => {
  const sealed = encryptSecret(TOKEN, SECRET, 'telegram-bot-token');
  assert.ok(!sealed.includes('123456789'));
  assert.equal(decryptSecret(sealed, SECRET, 'telegram-bot-token'), TOKEN);
  assert.notEqual(sealed, encryptSecret(TOKEN, SECRET, 'telegram-bot-token'), 'fresh nonce each time');
  assert.throws(() => decryptSecret(sealed, SECRET, 'something-else'));
  assert.throws(() => decryptSecret(sealed, 'f'.repeat(64), 'telegram-bot-token'));
  assert.throws(() => decryptSecret('garbage', SECRET, 'telegram-bot-token'));
});

test('the client posts to the worker address, uses multipart for files and hides the token in errors', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), body: init.body, headers: init.headers });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), { headers: { 'content-type': 'application/json' } });
  };
  const client = createTelegramClient({ baseUrl: 'https://bots.example.dev/', fetchImpl });
  assert.deepEqual(await client.call(TOKEN, 'sendMessage', { chat_id: '@c', text: 'hi' }), { message_id: 9 });
  assert.equal(seen[0].url, `https://bots.example.dev/bot${TOKEN}/sendMessage`);
  assert.equal(JSON.parse(seen[0].body).text, 'hi');
  await client.call(TOKEN, 'sendPhoto', { chat_id: '@c', reply_markup: { inline_keyboard: [] } }, { photo: { data: Buffer.from('x'), filename: 'a.jpg', type: 'image/jpeg' } });
  assert.ok(seen[1].body instanceof FormData);
  assert.equal(seen[1].body.get('reply_markup'), '{"inline_keyboard":[]}');
  assert.ok(seen[1].body.get('photo') instanceof Blob);

  const failing = createTelegramClient({
    baseUrl: 'https://bots.example.dev',
    fetchImpl: async () => new Response(JSON.stringify({ ok: false, error_code: 400, description: `Bad Request: chat not found for ${TOKEN}` }), { status: 400 }),
  });
  await assert.rejects(failing.call(TOKEN, 'getChat', { chat_id: '@c' }), (error) => {
    assert.ok(error instanceof TelegramError);
    assert.equal(error.code, 400);
    assert.ok(!error.message.includes('AAAAAAAA'));
    return true;
  });
  await assert.rejects(client.call('not-a-token', 'getMe'), /Invalid token/);
});

test('the fallback address is used only when the first one does not answer like Telegram', async () => {
  const hits = [];
  const fetchImpl = async (url) => {
    hits.push(String(url));
    if (String(url).startsWith('https://first.example')) return new Response('<html>bad gateway</html>', { status: 502 });
    return new Response(JSON.stringify({ ok: true, result: 1 }), { headers: { 'content-type': 'application/json' } });
  };
  const client = createTelegramClient({ baseUrl: 'https://first.example', fallbackUrl: 'https://second.example', fetchImpl });
  assert.equal(await client.call(TOKEN, 'getMe'), 1);
  assert.deepEqual(hits.map((hit) => new URL(hit).host), ['first.example', 'second.example']);

  // an answer from Telegram itself (even an error) is final and does not trigger the fallback
  const hits2 = [];
  const strict = createTelegramClient({
    baseUrl: 'https://first.example', fallbackUrl: 'https://second.example',
    fetchImpl: async (url) => { hits2.push(String(url)); return new Response(JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden' }), { status: 403 }); },
  });
  await assert.rejects(strict.call(TOKEN, 'sendMessage', {}), (error) => error.code === 403);
  assert.equal(hits2.length, 1);

  const down = createTelegramClient({ baseUrl: 'https://first.example', fetchImpl: async () => { throw new Error('boom'); } });
  await assert.rejects(down.call(TOKEN, 'getMe'), (error) => error.network === true);
});

test('failures are described in Persian without raw details', () => {
  assert.match(describeTelegramError(new TelegramError('x', { code: 401 })), /توکن/);
  assert.match(describeTelegramError(new TelegramError('Bad Request: chat not found', { code: 400 })), /کانال پیدا نشد/);
  assert.match(describeTelegramError(new TelegramError('Forbidden', { code: 403 })), /مدیر کانال/);
  assert.match(describeTelegramError(new TelegramError('x', { network: true })), /اتصال/);
});

test('the Telegram address comes from the configuration and must be https', () => {
  const env = {
    PORT: '3000', NODE_ENV: 'development', PUBLIC_URL: 'http://localhost:3000', DB_HOST: 'h', DB_PORT: '3306', DB_NAME: 'n',
    DB_USER: 'u', DB_PASSWORD: 'p', APP_SECRET: SECRET, UPLOAD_DIR: '/tmp/u',
  };
  const config = loadConfig(env);
  assert.equal(config.telegramApiBase, 'https://bots.realdream.workers.dev');
  assert.equal(config.telegramApiFallback, '');
  assert.equal(loadConfig({ ...env, TELEGRAM_API_BASE: 'https://tg.example.com/', TELEGRAM_API_FALLBACK: 'https://api.telegram.org' }).telegramApiBase, 'https://tg.example.com');
  assert.throws(() => loadConfig({ ...env, TELEGRAM_API_BASE: 'http://tg.example.com' }), /https/);
  assert.throws(() => loadConfig({ ...env, TELEGRAM_API_FALLBACK: 'ftp://x' }), /https/);
});

test('the proxy address must be a plain http://host:port', () => {
  assert.deepEqual(parseProxyUrl('http://v2raya:20171'), { hostname: 'v2raya', port: 20171 });
  for (const bad of ['', 'v2raya:20171', 'https://v2raya:20171', 'http://u:p@v2raya:1', 'http://v2raya:1/x', 'socks5://v2raya:1080']) {
    assert.throws(() => parseProxyUrl(bad), /TELEGRAM|proxy/, bad);
  }
});

test('a proxy that refuses the tunnel is reported as a network failure with its code', async () => {
  const seen = [];
  const proxy = http.createServer();
  proxy.on('connect', (request, socket) => { seen.push(request.url); socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const client = createTelegramClient({ baseUrl: 'https://api.telegram.org', fetchImpl: createProxyFetch(`http://127.0.0.1:${proxy.address().port}`) });
    await assert.rejects(client.call(TOKEN, 'getMe'), (error) => error.network === true && error.detail === 'PROXY_403');
    assert.deepEqual(seen, ['api.telegram.org:443']);
  } finally { proxy.close(); }
});

test('JSON and multipart calls go through the CONNECT tunnel and come back parsed', async (t) => {
  let cert;
  try {
    const dir = mkdtempSync(path.join(tmpdir(), 'pnu-tls-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-subj', '/CN=localhost', '-days', '1'], { stdio: 'ignore' });
    cert = { key: readFileSync(path.join(dir, 'k.pem')), cert: readFileSync(path.join(dir, 'c.pem')) };
  } catch { t.skip('openssl is not available'); return; }

  const received = [];
  const origin = https.createServer(cert, (request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      received.push({ url: request.url, type: request.headers['content-type'], size: Buffer.concat(chunks).length });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, result: { message_id: 7 } }));
    });
  });
  await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve));
  const proxy = http.createServer();
  proxy.on('connect', (request, socket) => {
    // whatever address is asked for, the test tunnel ends at the local origin
    const upstream = net.connect(origin.address().port, '127.0.0.1', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); upstream.pipe(socket); socket.pipe(upstream); });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const fetchImpl = createProxyFetch(`http://127.0.0.1:${proxy.address().port}`, { tlsOptions: { rejectUnauthorized: false } });
    const client = createTelegramClient({ baseUrl: 'https://api.telegram.org', fetchImpl });
    const sent = await client.call(TOKEN, 'sendMessage', { chat_id: '@x', text: 'سلام' });
    assert.equal(sent.message_id, 7);
    const photo = Buffer.alloc(200_000, 7);
    await client.call(TOKEN, 'sendPhoto', { chat_id: '@x', caption: 'c' }, { photo: { data: photo, filename: 'cover.jpg', type: 'image/jpeg' } });
    assert.equal(received[0].url, `/bot${TOKEN}/sendMessage`);
    assert.match(received[1].type, /^multipart\/form-data; boundary=/);
    assert.ok(received[1].size > 200_000);
  } finally { proxy.close(); origin.close(); }
});
