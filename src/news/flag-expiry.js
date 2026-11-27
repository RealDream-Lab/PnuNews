// «مهم» (سنجاق) و «فوری» فقط برای مدتی محدود پس از انتشار معنا دارند؛ بعد از آن خبر یک خبر عادی می‌شود.
export const FLAG_LIFETIME_HOURS = 72;
export const FLAG_LIFETIME_MS = FLAG_LIFETIME_HOURS * 60 * 60 * 1000;

// Has the news been published for so long that it can no longer be important or urgent?
// A missing or future date (draft, scheduled) has not expired.
export function flagsHaveExpired(publishedAt, now = Date.now()) {
  if (!publishedAt) return false;
  const time = new Date(publishedAt).getTime();
  return Number.isFinite(time) && now - time >= FLAG_LIFETIME_MS;
}

// Lists in the panel show the «مهم» / «فوری» buttons only on published news that is still inside the window.
// The server decides (its own clock), the same way the single-news answer does with `flags_expired`.
export function flagsExpiredFor(news, now = Date.now()) {
  return news?.status === 'published' && flagsHaveExpired(news.published_at, now);
}
