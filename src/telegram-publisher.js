import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { appEvents } from './events.js';
import { decryptSecret, encryptSecret } from './auth/crypto.js';
import { TOKEN_PATTERN, TelegramError, describeTelegramError, parseChannelRef } from './lib/telegram.js';

const SECRET_PURPOSE = 'telegram-bot-token';
// Delivery is retried until it succeeds (there is no attempt limit); only the pause differs by cause.
// transient: Telegram or the network is down, so the very next queue round (every few seconds) tries again.
const RETRY_SECONDS = { transient: 0, access: 30, other: 60 };
const MAX_POST_AGE_DAYS = 2;
const CHANNEL_FAILURES_BEFORE_DISABLE = 3;
const CAPTION_LIMIT = 1024;

// ---------- Pure helpers (unit-tested) ----------

export function escapeTelegramHtml(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Bold title, a blank line, the summary as plain text. The caption may hold 1024 characters of visible text.
export function buildCaption({ title, summary }) {
  const cleanTitle = String(title ?? '').trim();
  let cleanSummary = String(summary ?? '').trim();
  const room = CAPTION_LIMIT - cleanTitle.length - 2;
  if (cleanSummary.length > room) cleanSummary = room > 1 ? `${cleanSummary.slice(0, room - 1).trimEnd()}…` : '';
  return cleanSummary ? `<b>${escapeTelegramHtml(cleanTitle)}</b>\n\n${escapeTelegramHtml(cleanSummary)}` : `<b>${escapeTelegramHtml(cleanTitle)}</b>`;
}

export function buttonLabel(newsType) {
  return newsType === 'announcement' ? 'مشاهدهٔ اطلاعیه' : 'مشاهدهٔ خبر';
}

export function newsUrl(publicUrl, newsId) {
  return `${publicUrl.replace(/\/+$/, '')}/n/${Number(newsId)}`;
}

export function textHash({ title, summary, newsType, url }) {
  return createHash('sha256').update(JSON.stringify([title, summary, newsType, url])).digest('hex');
}

export function retryDelaySeconds(kind) {
  return RETRY_SECONDS[kind] ?? RETRY_SECONDS.other;
}

// "transient" = nothing reached Telegram or it failed on its side; "access" = bot/channel permission problems;
// "other" = Telegram refused the request itself (something about the message or the settings must change).
export function failureKind(error) {
  if (!(error instanceof TelegramError)) return 'other';
  if (error.network || error.code >= 500) return 'transient';
  if (error.code === 401 || error.code === 403 || /chat not found/i.test(error.message)) return 'access';
  return 'other';
}

function ancestry(regionId, regionMap) {
  const ids = new Set();
  let current = regionMap.get(Number(regionId));
  while (current && !ids.has(Number(current.id))) {
    ids.add(Number(current.id));
    current = current.parent_id == null ? null : regionMap.get(Number(current.parent_id));
  }
  return ids;
}

// A channel gets a news item when the item targets the owner's own unit or any unit above it.
// The same Telegram chat is never used twice for one item (two users may share a channel).
export function channelsForNews({ targetIds, regions, channels }) {
  const targets = new Set(targetIds.map(Number));
  const regionMap = new Map(regions.map((region) => [Number(region.id), region]));
  const seenChats = new Set();
  const result = [];
  for (const channel of [...channels].sort((a, b) => Number(a.user_id) - Number(b.user_id))) {
    const chain = ancestry(channel.region_id, regionMap);
    if (![...chain].some((id) => targets.has(id))) continue;
    if (seenChats.has(String(channel.chat_id))) continue;
    seenChats.add(String(channel.chat_id));
    result.push(channel);
  }
  return result;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- Service ----------

export function createTelegramService({
  pool,
  config,
  client,
  uploadRoot,
  publicDir,
  events = appEvents,
  pauseMs = 1500,
  intervalMs = 10_000,
  pause = sleep,
  log = (message) => console.error(message),
}) {
  let timer = null;
  let running = false;
  const uploadBase = path.resolve(uploadRoot);

  const tokenFor = (row) => decryptSecret(row.bot_token_enc, config.appSecret, SECRET_PURPOSE);

  // ----- photo -----
  async function loadPhoto(coverStoredName, newsType) {
    const candidates = [];
    if (typeof coverStoredName === 'string' && /^img\/\d{4}\/(0[1-9]|1[0-2])\/[a-f\d]{32}$/i.test(coverStoredName)) {
      candidates.push({ key: coverStoredName, file: path.resolve(uploadBase, `${coverStoredName}-1280.webp`), inside: uploadBase });
    }
    const defaultName = newsType === 'announcement' ? 'default-announcement' : 'default-news';
    candidates.push({ key: defaultName, file: path.resolve(publicDir, 'covers', `${defaultName}.v1.1280.webp`), inside: path.resolve(publicDir) });
    const { default: sharp } = await import('sharp');
    for (const candidate of candidates) {
      if (!candidate.file.startsWith(`${candidate.inside}${path.sep}`)) continue;
      try {
        const source = await readFile(candidate.file);
        // Telegram is happiest with JPEG; flatten transparency onto white.
        const data = await sharp(source).rotate().flatten({ background: '#ffffff' }).resize({ width: 1280, withoutEnlargement: true }).jpeg({ quality: 86 }).toBuffer();
        return { key: candidate.key, data };
      } catch {
        // missing or unreadable: try the next candidate (the built-in default)
      }
    }
    throw new Error('no cover image available');
  }

  // ----- recipients -----
  async function enqueue(newsId) {
    const [newsRows] = await pool.execute(
      `SELECT id FROM news WHERE id = ? AND status = 'published' AND deleted_at IS NULL AND source_url IS NULL
         AND published_at <= UTC_TIMESTAMP()`,
      [Number(newsId)],
    );
    if (!newsRows.length) return 0;
    const [[targets], [regions], [channels]] = await Promise.all([
      pool.execute('SELECT region_id FROM news_targets WHERE news_id = ?', [Number(newsId)]),
      pool.query('SELECT id, parent_id FROM regions'),
      pool.query(
        `SELECT c.user_id, c.chat_id, u.region_id FROM telegram_channels c
         JOIN users u ON u.id = c.user_id WHERE c.enabled = 1 AND u.is_active = 1`,
      ),
    ]);
    const chosen = channelsForNews({ targetIds: targets.map((row) => row.region_id), regions, channels });
    let created = 0;
    for (const channel of chosen) {
      // another user already got this item into the same chat
      const [existing] = await pool.execute('SELECT 1 FROM telegram_posts WHERE news_id = ? AND chat_id = ? LIMIT 1', [Number(newsId), String(channel.chat_id)]);
      if (existing.length) continue;
      const [result] = await pool.execute(
        'INSERT IGNORE INTO telegram_posts (news_id, user_id, chat_id) VALUES (?, ?, ?)',
        [Number(newsId), channel.user_id, String(channel.chat_id)],
      );
      created += result.affectedRows;
    }
    return created;
  }

  async function markForUpdate(newsId) {
    await pool.execute(
      `UPDATE telegram_posts SET needs_update = 1, next_attempt_at = UTC_TIMESTAMP(), attempts = 0
       WHERE news_id = ? AND state = 'sent' AND message_id IS NOT NULL`,
      [Number(newsId)],
    );
  }

  // ----- delivery -----
  async function recordChannelSuccess(userId) {
    await pool.execute('UPDATE telegram_channels SET fail_count = 0, last_error = NULL, last_sent_at = UTC_TIMESTAMP() WHERE user_id = ?', [userId]);
  }

  async function recordChannelFailure(userId, message) {
    await pool.execute('UPDATE telegram_channels SET fail_count = fail_count + 1, last_error = ? WHERE user_id = ?', [message.slice(0, 300), userId]);
    const [rows] = await pool.execute('SELECT fail_count FROM telegram_channels WHERE user_id = ?', [userId]);
    if (rows[0] && Number(rows[0].fail_count) >= CHANNEL_FAILURES_BEFORE_DISABLE) {
      await pool.execute(
        'UPDATE telegram_channels SET enabled = 0, last_error = ? WHERE user_id = ?',
        [`ارسال خودکار به‌دلیل خطای پیاپی غیرفعال شد: ${message}`.slice(0, 300), userId],
      );
    }
  }

  async function failPost(post, message, { final, kind = 'other' }) {
    if (final) {
      await pool.execute(
        `UPDATE telegram_posts SET state = IF(state = 'sent', 'sent', 'failed'), needs_update = 0, last_error = ? WHERE news_id = ? AND user_id = ?`,
        [message.slice(0, 300), post.news_id, post.user_id],
      );
      return;
    }
    await pool.execute(
      `UPDATE telegram_posts SET attempts = attempts + 1, last_error = ?,
         next_attempt_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND) WHERE news_id = ? AND user_id = ?`,
      [message.slice(0, 300), retryDelaySeconds(kind), post.news_id, post.user_id],
    );
  }

  async function deliver(post) {
    const [rows] = await pool.execute(
      `SELECT n.id, n.title, n.summary, n.news_type, n.status, n.published_at, n.deleted_at, n.source_url,
              cover.stored_name AS cover_stored_name
       FROM news n LEFT JOIN attachments cover ON cover.id = n.cover_attachment_id WHERE n.id = ? LIMIT 1`,
      [post.news_id],
    );
    const news = rows[0];
    const sendable = news && !news.deleted_at && !news.source_url && news.status === 'published' && news.published_at <= new Date();
    if (!sendable) {
      // not (or no longer) public: a message that was never sent is dropped, one already in the channel is left alone
      if (post.state === 'pending') await pool.execute('DELETE FROM telegram_posts WHERE news_id = ? AND user_id = ?', [post.news_id, post.user_id]);
      else await pool.execute('UPDATE telegram_posts SET needs_update = 0 WHERE news_id = ? AND user_id = ?', [post.news_id, post.user_id]);
      return;
    }

    const token = tokenFor(post);
    const url = newsUrl(config.publicUrl, news.id);
    const hash = textHash({ title: news.title, summary: news.summary, newsType: news.news_type, url });
    const caption = buildCaption({ title: news.title, summary: news.summary });
    const replyMarkup = { inline_keyboard: [[{ text: buttonLabel(news.news_type), url }]] };

    if (post.state === 'sent') {
      const photo = await loadPhoto(news.cover_stored_name, news.news_type);
      const coverChanged = photo.key !== post.cover_key;
      if (!coverChanged && hash === post.text_hash) {
        await pool.execute('UPDATE telegram_posts SET needs_update = 0 WHERE news_id = ? AND user_id = ?', [post.news_id, post.user_id]);
        return;
      }
      try {
        if (coverChanged) {
          await client.call(token, 'editMessageMedia', {
            chat_id: post.chat_id,
            message_id: Number(post.message_id),
            media: { type: 'photo', media: 'attach://photo', caption, parse_mode: 'HTML' },
            reply_markup: replyMarkup,
          }, { photo: { data: photo.data, filename: 'cover.jpg', type: 'image/jpeg' } });
        } else {
          await client.call(token, 'editMessageCaption', {
            chat_id: post.chat_id,
            message_id: Number(post.message_id),
            caption,
            parse_mode: 'HTML',
            reply_markup: replyMarkup,
          });
        }
      } catch (error) {
        if (!(error instanceof TelegramError && /message is not modified/i.test(error.message))) throw error;
      }
      await pool.execute(
        `UPDATE telegram_posts SET text_hash = ?, cover_key = ?, needs_update = 0, attempts = 0, last_error = NULL
         WHERE news_id = ? AND user_id = ?`,
        [hash, photo.key, post.news_id, post.user_id],
      );
      await recordChannelSuccess(post.user_id);
      return;
    }

    const photo = await loadPhoto(news.cover_stored_name, news.news_type);
    const sent = await client.call(token, 'sendPhoto', {
      chat_id: post.channel_chat_id,
      caption,
      parse_mode: 'HTML',
      reply_markup: replyMarkup,
    }, { photo: { data: photo.data, filename: 'cover.jpg', type: 'image/jpeg' } });
    await pool.execute(
      `UPDATE telegram_posts SET state = 'sent', chat_id = ?, message_id = ?, text_hash = ?, cover_key = ?,
         needs_update = 0, attempts = 0, last_error = NULL WHERE news_id = ? AND user_id = ?`,
      [String(post.channel_chat_id), Number(sent.message_id), hash, photo.key, post.news_id, post.user_id],
    );
    await recordChannelSuccess(post.user_id);
  }

  async function handleFailure(post, error) {
    if (!(error instanceof TelegramError)) {
      log(`Telegram delivery failed for news ${post.news_id}: ${error.message}`);
      await failPost(post, 'خطای داخلی در آماده‌سازی پیام.', { final: false, kind: 'other' });
      return;
    }
    const message = describeTelegramError(error);
    if (error.code === 429) {
      // rate limit: wait as long as Telegram says, without counting it as a failed attempt
      await pool.execute(
        'UPDATE telegram_posts SET last_error = ?, next_attempt_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND) WHERE news_id = ? AND user_id = ?',
        [message, Math.max(error.retryAfter, 5) + 1, post.news_id, post.user_id],
      );
      return;
    }
    if (post.state === 'sent' && /message to edit not found|message can't be edited|message_id_invalid/i.test(error.message)) {
      // the message was removed from the channel by hand: nothing left to keep in sync
      await failPost(post, message, { final: true });
      return;
    }
    const kind = failureKind(error);
    if (kind === 'access') await recordChannelFailure(post.user_id, message);
    await failPost(post, message, { final: false, kind });
  }

  async function processQueue() {
    if (running) return 0;
    running = true;
    let handled = 0;
    try {
      const [posts] = await pool.query(
        `SELECT p.news_id, p.user_id, p.chat_id, p.message_id, p.state, p.needs_update, p.text_hash, p.cover_key,
                p.attempts, p.created_at, c.bot_token_enc, c.chat_id AS channel_chat_id
         FROM telegram_posts p JOIN telegram_channels c ON c.user_id = p.user_id
         WHERE c.enabled = 1 AND (p.state = 'pending' OR (p.state = 'sent' AND p.needs_update = 1))
           AND p.next_attempt_at <= UTC_TIMESTAMP()
         ORDER BY p.next_attempt_at, p.news_id LIMIT 10`,
      );
      for (const post of posts) {
        if (handled) await pause(pauseMs);
        handled += 1;
        if (post.state === 'pending' && Date.now() - new Date(post.created_at).getTime() > MAX_POST_AGE_DAYS * 86_400_000) {
          await failPost(post, 'ارسال به‌دلیل گذشت زمان منقضی شد.', { final: true });
          continue;
        }
        try {
          await deliver(post);
        } catch (error) {
          await handleFailure(post, error);
        }
      }
    } finally {
      running = false;
    }
    return handled;
  }

  // ----- per-user channel settings -----
  async function loadChannelRow(userId) {
    const [rows] = await pool.execute('SELECT * FROM telegram_channels WHERE user_id = ? LIMIT 1', [userId]);
    return rows[0] ?? null;
  }

  async function summary(userId) {
    const row = await loadChannelRow(userId);
    if (!row) return { configured: false };
    const [posts] = await pool.execute(
      `SELECT p.news_id, n.title, p.state, p.needs_update, p.last_error, p.updated_at
       FROM telegram_posts p JOIN news n ON n.id = p.news_id WHERE p.user_id = ? ORDER BY p.updated_at DESC, p.news_id DESC LIMIT 8`,
      [userId],
    );
    return {
      configured: true,
      enabled: Boolean(row.enabled),
      bot_username: row.bot_username,
      chat_ref: row.chat_ref,
      chat_title: row.chat_title,
      fail_count: Number(row.fail_count),
      last_error: row.last_error,
      last_sent_at: row.last_sent_at ? new Date(row.last_sent_at).toISOString() : null,
      posts: posts.map((post) => ({
        news_id: Number(post.news_id),
        title: post.title,
        state: post.state,
        needs_update: Boolean(post.needs_update),
        last_error: post.last_error,
        updated_at: new Date(post.updated_at).toISOString(),
      })),
    };
  }

  // Checks the bot token, finds the channel and makes sure the bot may post there.
  async function verify(token, channelRef) {
    const bot = await client.call(token, 'getMe');
    const chat = await client.call(token, 'getChat', { chat_id: channelRef });
    if (!['channel', 'supergroup', 'group'].includes(chat.type)) {
      throw new TelegramError('chat not found', { code: 400 });
    }
    const member = await client.call(token, 'getChatMember', { chat_id: chat.id, user_id: bot.id });
    const allowed = member.status === 'creator' || (member.status === 'administrator' && member.can_post_messages !== false);
    if (!allowed) throw new TelegramError('not enough rights', { code: 403 });
    return { bot, chat };
  }

  async function save(userId, { botToken, channel, enabled }) {
    const existing = await loadChannelRow(userId);
    const channelRef = parseChannelRef(channel);
    if (!channelRef) return { error: 'شناسهٔ کانال معتبر نیست؛ مثل @my_channel یا -1001234567890 وارد کنید.' };
    let token = typeof botToken === 'string' && botToken.trim() ? botToken.trim() : null;
    if (token && !TOKEN_PATTERN.test(token)) return { error: 'قالب توکن ربات معتبر نیست (مثل 123456789:AA…).' };
    if (!token && !existing) return { error: 'توکن ربات را وارد کنید.' };
    if (!token) token = tokenFor(existing);

    const changed = !existing || Boolean(botToken?.trim()) || existing.chat_ref !== channelRef;
    // turning a connection back on re-checks it: it was probably switched off because something stopped working
    const needsCheck = changed || (enabled && !existing.enabled);
    let botUsername = existing?.bot_username ?? null;
    let chatId = existing?.chat_id ?? null;
    let chatTitle = existing?.chat_title ?? null;
    if (needsCheck) {
      try {
        const checked = await verify(token, channelRef);
        botUsername = checked.bot.username ?? null;
        chatId = String(checked.chat.id);
        chatTitle = checked.chat.title ?? null;
      } catch (error) {
        return { error: describeTelegramError(error) };
      }
    }

    await pool.execute(
      `INSERT INTO telegram_channels (user_id, enabled, bot_token_enc, bot_username, chat_ref, chat_id, chat_title)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), bot_token_enc = VALUES(bot_token_enc), bot_username = VALUES(bot_username),
         chat_ref = VALUES(chat_ref), chat_id = VALUES(chat_id), chat_title = VALUES(chat_title),
         fail_count = IF(VALUES(enabled) = 1, 0, fail_count), last_error = IF(VALUES(enabled) = 1, NULL, last_error)`,
      [userId, enabled ? 1 : 0, encryptSecret(token, config.appSecret, SECRET_PURPOSE), botUsername, channelRef, chatId, chatTitle],
    );
    // A different bot or channel: messages already sent live somewhere this connection can no longer edit.
    if (existing && (botToken?.trim() || existing.chat_ref !== channelRef)) {
      await pool.execute('DELETE FROM telegram_posts WHERE user_id = ?', [userId]);
    }
    return { ok: true };
  }

  async function setEnabled(userId, enabled) {
    const [result] = await pool.execute(
      `UPDATE telegram_channels SET enabled = ?, fail_count = IF(? = 1, 0, fail_count), last_error = IF(? = 1, NULL, last_error) WHERE user_id = ?`,
      [enabled ? 1 : 0, enabled ? 1 : 0, enabled ? 1 : 0, userId],
    );
    return result.affectedRows > 0;
  }

  async function remove(userId) {
    await pool.execute('DELETE FROM telegram_posts WHERE user_id = ?', [userId]);
    const [result] = await pool.execute('DELETE FROM telegram_channels WHERE user_id = ?', [userId]);
    return result.affectedRows > 0;
  }

  async function sendTest(userId, { unitName }) {
    const row = await loadChannelRow(userId);
    if (!row) return { error: 'ابتدا اتصال ربات و کانال را ذخیره کنید.' };
    try {
      await client.call(tokenFor(row), 'sendMessage', {
        chat_id: row.chat_id,
        text: `✅ اتصال برقرار است.\nخبرهای ${unitName} از این پس در همین کانال هم منتشر می‌شود.`,
      });
      await recordChannelSuccess(userId);
      return { ok: true };
    } catch (error) {
      const message = describeTelegramError(error);
      await pool.execute('UPDATE telegram_channels SET last_error = ? WHERE user_id = ?', [message.slice(0, 300), userId]);
      return { error: message };
    }
  }

  // ----- lifecycle -----
  const onPublished = ({ id }) => { enqueue(id).catch((error) => log(`Telegram enqueue failed: ${error.message}`)); };
  const onChanged = ({ id }) => { if (id) markForUpdate(id).catch((error) => log(`Telegram update mark failed: ${error.message}`)); };

  function start() {
    if (timer) return;
    events.on('news.published', onPublished);
    events.on('news.changed', onChanged);
    timer = setInterval(() => {
      processQueue().catch((error) => log(`Telegram queue failed: ${error.message}`));
    }, intervalMs);
    timer.unref?.();
  }

  function stop() {
    events.off('news.published', onPublished);
    events.off('news.changed', onChanged);
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, enqueue, markForUpdate, processQueue, summary, save, setEnabled, remove, sendTest };
}
