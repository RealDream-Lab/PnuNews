// Merging the bookmarks of one reader: what a device sends with what the server already has. Pure on purpose (no
// database, no clock of its own), so every rule can be tested.
//
// A record is { newsId, savedAt, deletedAt, updatedAt } with times in milliseconds. A removed bookmark stays as a tombstone
// (deletedAt set) so another device cannot bring it back. For each news the newest change wins; a tie keeps what the server
// has. updatedAt is the time of the last change: deletedAt for a tombstone, savedAt for a live bookmark.
export const MAX_BOOKMARKS_PER_READER = 500;
export const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60_000;
export const CLOCK_SKEW_MS = 5 * 60_000; // a device clock that runs ahead must not win every later comparison
export const MAX_SYNC_ITEMS = 1500;

const isTime = (value) => Number.isSafeInteger(value) && value > 0;

// body: the parsed JSON a device sent. Returns { items } (checked, one per news, times clamped, expired tombstones left out)
// or { error } when the request itself is malformed. An item about a news that does not exist is not this function's business.
export function parseSyncItems(body, now) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.items)) return { error: 'فهرست نشانک‌ها معتبر نیست.' };
  if (body.items.length > MAX_SYNC_ITEMS) return { error: 'تعداد نشانک‌های ارسالی بیش از حد است.' };
  const ceiling = now + CLOCK_SKEW_MS;
  const byNews = new Map();
  for (const raw of body.items) {
    if (!raw || typeof raw !== 'object') return { error: 'فهرست نشانک‌ها معتبر نیست.' };
    const { newsId, savedAt } = raw;
    const deletedAt = raw.deletedAt ?? null;
    if (!isTime(newsId) || !isTime(savedAt) || (deletedAt !== null && (!isTime(deletedAt) || deletedAt < savedAt))) {
      return { error: 'فهرست نشانک‌ها معتبر نیست.' };
    }
    const item = { newsId, savedAt: Math.min(savedAt, ceiling), deletedAt: deletedAt === null ? null : Math.min(deletedAt, ceiling) };
    if (item.deletedAt !== null && now - item.deletedAt > TOMBSTONE_TTL_MS) continue; // an old removal is already forgotten
    const previous = byNews.get(newsId);
    if (!previous || (item.deletedAt ?? item.savedAt) > (previous.deletedAt ?? previous.savedAt)) byNews.set(newsId, item);
  }
  return { items: [...byNews.values()] };
}

// existing: [{ newsId, savedAt, deletedAt, updatedAt }] from the database. incoming: the items of parseSyncItems.
// Returns { records, changed }: every record after the merge (newest change first) and the ones to write.
export function mergeBookmarks(existing, incoming, { now, cap = MAX_BOOKMARKS_PER_READER }) {
  const next = new Map(existing.map((record) => [record.newsId, { ...record }]));
  for (const item of incoming) {
    const updatedAt = item.deletedAt ?? item.savedAt;
    const current = next.get(item.newsId);
    if (!current || updatedAt > current.updatedAt) next.set(item.newsId, { newsId: item.newsId, savedAt: item.savedAt, deletedAt: item.deletedAt, updatedAt });
  }
  // More live bookmarks than allowed: the oldest saved ones are removed (as tombstones, so every device learns of it).
  const live = [...next.values()].filter((record) => record.deletedAt === null).sort((a, b) => a.savedAt - b.savedAt);
  for (const record of live.slice(0, Math.max(0, live.length - cap))) {
    const deletedAt = Math.max(now, record.savedAt + 1);
    next.set(record.newsId, { ...record, deletedAt, updatedAt: deletedAt });
  }
  for (const [newsId, record] of next) {
    if (record.deletedAt !== null && now - record.deletedAt > TOMBSTONE_TTL_MS) next.delete(newsId);
  }
  const before = new Map(existing.map((record) => [record.newsId, record]));
  const same = (a, b) => a && a.savedAt === b.savedAt && a.deletedAt === b.deletedAt && a.updatedAt === b.updatedAt;
  const records = [...next.values()].sort((a, b) => b.updatedAt - a.updatedAt || b.newsId - a.newsId);
  return { records, changed: records.filter((record) => !same(before.get(record.newsId), record)) };
}
