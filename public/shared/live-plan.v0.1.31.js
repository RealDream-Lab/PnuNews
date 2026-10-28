// Pure helpers for live feed updates: compare what the reader shows with a fresh first page of the feed
// and say what to insert, update and remove. No DOM access here, so it can be unit-tested in Node.

export function itemSignature(item) {
  return [
    item.title, item.summary, item.news_type, item.is_urgent ? 1 : 0, item.is_pinned ? 1 : 0,
    item.category?.name ?? '', item.cover?.src ?? '', item.publisher_unit ?? '',
    item.scope?.type ?? '', item.scope?.name ?? '',
  ].join('\u0001');
}

const MAX_ANIMATED_INSERTS = 6;

// entries: [{ id, item, sig }] in on-screen order. data: the JSON of /api/public/feed (first page).
export function planLiveUpdate(entries, data) {
  const items = Array.isArray(data?.items) ? data.items : [];
  const pinned = Array.isArray(data?.pinned) ? data.pinned : [];
  const pinnedIds = new Set(pinned.map((item) => Number(item.id)));
  const visible = items.filter((item) => !pinnedIds.has(Number(item.id)));
  const visibleIds = new Set(visible.map((item) => Number(item.id)));
  const known = new Map(entries.map((entry) => [Number(entry.id), entry]));
  // When the response is only the first page, entries older than its last item are simply not covered by it.
  const windowStart = data?.next_cursor && items.length ? Date.parse(items.at(-1).published_at) : Number.NEGATIVE_INFINITY;

  const removed = entries
    .filter((entry) => pinnedIds.has(Number(entry.id))
      || (!visibleIds.has(Number(entry.id)) && Date.parse(entry.item.published_at) > windowStart))
    .map((entry) => Number(entry.id));

  const inserts = [];
  const updates = [];
  let afterId = null;
  for (const item of visible) {
    const id = Number(item.id);
    const entry = known.get(id);
    if (entry) {
      if (entry.sig !== itemSignature(item)) updates.push(item);
    } else {
      inserts.push({ item, afterId });
    }
    afterId = id;
  }

  const knownVisible = visible.filter((item) => known.has(Number(item.id))).length;
  const resync = inserts.length > MAX_ANIMATED_INSERTS || (entries.length > 0 && inserts.length > 0 && knownVisible === 0);
  return { items, pinned, pinnedIds, inserts, updates, removed, resync };
}

export function pinnedSignature(pinned) {
  return pinned.map((item) => `${Number(item.id)}:${itemSignature(item)}`).join('\u0002');
}
