import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptSecret, encryptSecret } from '../src/auth/crypto.js';
import { loadConfig } from '../src/config.js';
import { TelegramError, createTelegramClient, describeTelegramError, parseChannelRef } from '../src/lib/telegram.js';
import { buildCaption, buttonLabel, channelsForNews, newsUrl, retryDelaySeconds, textHash } from '../src/telegram-publisher.js';

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

test('retry delays grow and stay at the last step', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(retryDelaySeconds), [30, 120, 600, 1800, 7200, 7200]);
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
