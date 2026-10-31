import { createHash } from "node:crypto";
import { appEvents, emitNewsPublished } from "./events.js";
import { normalizeNewsInput } from "./news/content.js";
import { PORTAL_PROXY_URL, parseProxyNews, portalUrl } from "./portal-parse.js";

export const PORTAL_LIMIT = 20;
export const PORTAL_CATEGORY_NAME = "خبرهای پورتال سازمان مرکزی";
const BOT_USERNAME = "news-bot";
const BOT_NAME = "بات خبرخوان";
const BOT_UNIT = "پورتال سازمان مرکزی";
const USER_AGENT = "Mozilla/5.0 (compatible; PNU-News-Reader/1.0)";

const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );

export function createPortalImporter({
  pool,
  uploadRoot,
  fetchImpl = fetch,
  clock = Date.now,
  events = appEvents,
  logger = console,
  sourceUrl = process.env.PORTAL_NEWS_URL || PORTAL_PROXY_URL,
}) {
  let running = false;
  let timer = null;

  async function getSetting(key) {
    const [rows] = await pool.execute("SELECT v FROM settings WHERE k = ?", [
      key,
    ]);
    return rows[0]?.v ?? null;
  }
  async function setSetting(key, value) {
    await pool.execute(
      "INSERT INTO settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)",
      [key, value],
    );
  }

  async function status() {
    let lastRun = null;
    try {
      lastRun = JSON.parse(
        (await getSetting("portal_news_last_run")) || "null",
      );
    } catch {
      lastRun = null;
    }
    return {
      enabled: (await getSetting("portal_news_enabled")) !== "0",
      last_run: lastRun,
      source: sourceUrl,
      limit: PORTAL_LIMIT,
    };
  }

  // The bot user, the category and the country region are created on first use and found again afterwards.
  async function ensureSetup() {
    const [countries] = await pool.query(
      "SELECT id FROM regions WHERE type = 'country' ORDER BY id LIMIT 1",
    );
    if (!countries.length)
      throw new Error("منطقهٔ «کل کشور» در پایگاه داده پیدا نشد.");
    const countryId = Number(countries[0].id);

    const [bots] = await pool.execute(
      "SELECT id, is_system FROM users WHERE username = ?",
      [BOT_USERNAME],
    );
    let botId;
    if (bots.length) {
      if (!bots[0].is_system)
        throw new Error(
          "نام کاربری news-bot قبلاً برای کاربر دیگری استفاده شده است.",
        );
      botId = Number(bots[0].id);
    } else {
      // "!" is not a valid password hash and the account is inactive, so nobody can ever sign in as the bot.
      const [created] = await pool.execute(
        `INSERT INTO users (username, password_hash, full_name, role, region_id, is_active, must_change_password, is_system)
         VALUES (?, '!', ?, 'super_admin', ?, 0, 0, 1)`,
        [BOT_USERNAME, BOT_NAME, countryId],
      );
      botId = Number(created.insertId);
    }

    let categoryId = Number(await getSetting("portal_news_category_id")) || 0;
    if (categoryId) {
      const [found] = await pool.execute(
        "SELECT id FROM categories WHERE id = ?",
        [categoryId],
      );
      if (!found.length) categoryId = 0;
    }
    if (!categoryId) {
      const [byName] = await pool.execute(
        "SELECT id FROM categories WHERE name = ?",
        [PORTAL_CATEGORY_NAME],
      );
      if (byName.length) categoryId = Number(byName[0].id);
      else {
        const [top] = await pool.query(
          "SELECT COALESCE(MAX(sort_order), 0) AS top FROM categories",
        );
        const [created] = await pool.execute(
          "INSERT INTO categories (name, sort_order, is_active) VALUES (?, ?, 1)",
          [PORTAL_CATEGORY_NAME, Number(top[0].top) + 1],
        );
        categoryId = Number(created.insertId);
      }
      await setSetting("portal_news_category_id", String(categoryId));
    }
    return { botId, categoryId, countryId };
  }

  async function fetchJson(url) {
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { "user-agent": USER_AGENT, accept: "application/json" },
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new Error(
        `اتصال به سرور رادیو برقرار نشد (${error.cause?.code || error.name}).`,
      );
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {}
    if (!response.ok)
      throw new Error(
        `پاسخ نامعتبر از سرور رادیو: ${response.status}${payload?.message ? ` — ${payload.message}` : ""}`,
      );
    return payload;
  }

  async function importOne(item, setup) {
    const sourceHash = createHash("sha256").update(item.link).digest("hex");
    const [existing] = await pool.execute(
      "SELECT id FROM news WHERE source_hash = ?",
      [sourceHash],
    );
    if (existing.length) {
      // News imported before the image address was stored get it now.
      if (item.image)
        await pool.execute(
          "UPDATE news SET source_image_url = ? WHERE id = ? AND source_image_url IS NULL",
          [item.image, Number(existing[0].id)],
        );
      return false;
    }
    const now = new Date(clock());
    const published =
      item.timestamp_ms && item.timestamp_ms < now.getTime()
        ? new Date(item.timestamp_ms)
        : now;
    const text = normalizeNewsInput({
      title: item.title.slice(0, 240),
      summary: item.abstract.slice(0, 600),
      body_html: `${item.abstract ? `<p>${escapeHtml(item.abstract)}</p>` : ""}<p><a href="${escapeHtml(item.link)}" target="_blank" rel="noopener noreferrer">مشاهدهٔ متن کامل در پورتال دانشگاه</a></p>`,
    });
    if (!text.title) return false;
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [news] = await connection.execute(
        `INSERT INTO news (title, summary, body_html, search_text, category_id, status, published_at, origin_region_id,
                           published_by_user_id, publisher_name, publisher_unit, created_by, updated_by, source_url, source_hash, source_image_url)
         VALUES (?, ?, ?, ?, ?, 'published', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          text.title,
          text.summary,
          text.body_html,
          text.search_text,
          setup.categoryId,
          published,
          setup.countryId,
          setup.botId,
          BOT_NAME,
          BOT_UNIT,
          setup.botId,
          setup.botId,
          item.link,
          sourceHash,
          item.image,
        ],
      );
      const newsId = Number(news.insertId);
      await connection.execute(
        "INSERT INTO news_targets (news_id, region_id) VALUES (?, ?)",
        [newsId, setup.countryId],
      );
      await connection.execute(
        "INSERT INTO audit_log (user_id, action, entity, entity_id, meta) VALUES (?, 'news.import', 'news', ?, ?)",
        [setup.botId, newsId, JSON.stringify({ source: item.link })],
      );
      await connection.commit();
      emitNewsPublished(events, newsId);
      events.emit("news.changed", { id: newsId });
      return true;
    } catch (error) {
      await connection.rollback();
      if (error.code === "ER_DUP_ENTRY") return false;
      throw error;
    } finally {
      connection.release();
    }
  }

  async function runOnce({ force = false } = {}) {
    if (running) return { created: 0, total: 0, skipped: true };
    if (!force && (await status()).enabled === false)
      return { created: 0, total: 0, disabled: true };
    running = true;
    const result = {
      at: new Date(clock()).toISOString(),
      created: 0,
      total: 0,
      error: null,
    };
    try {
      const items = parseProxyNews(await fetchJson(sourceUrl), PORTAL_LIMIT);
      if (!items.length) throw new Error("سرور رادیو فهرست خبر خالی برگرداند.");
      result.total = items.length;
      const setup = await ensureSetup();
      let failures = 0;
      for (const item of [...items].reverse()) {
        // oldest first, so ids follow the publishing order
        try {
          if (await importOne(item, setup)) result.created += 1;
        } catch (error) {
          failures += 1;
          result.error = `ثبت ${failures} خبر ناموفق بود: ${error.message}`;
          logger.error?.(`[portal-news] ${error.message}`);
        }
      }
    } catch (error) {
      result.error = error.message;
      logger.error?.(`[portal-news] ${error.message}`);
    } finally {
      running = false;
      try {
        await setSetting("portal_news_last_run", JSON.stringify(result));
      } catch {}
    }
    if (result.created)
      logger.info?.(
        `[portal-news] ${result.created} خبر تازه از پورتال دریافت شد.`,
      );
    return result;
  }

  function start({ intervalMs = 10 * 60_000, initialDelayMs = 20_000 } = {}) {
    stop();
    const tick = () => {
      runOnce().catch((error) =>
        logger.error?.(`[portal-news] ${error.message}`),
      );
    };
    timer = setTimeout(function loop() {
      tick();
      timer = setTimeout(loop, intervalMs);
      timer.unref?.();
    }, initialDelayMs);
    timer.unref?.();
  }
  function stop() {
    clearTimeout(timer);
    timer = null;
  }

  return {
    runOnce,
    start,
    stop,
    status,
    setEnabled: (enabled) =>
      setSetting("portal_news_enabled", enabled ? "1" : "0"),
  };
}
