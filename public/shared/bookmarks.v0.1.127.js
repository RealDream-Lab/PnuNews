// Reader bookmarks ("saved news"), kept on this device only (localStorage).
//
// A record is { id, savedAt, deletedAt, snap }. Removing a bookmark does not delete the record: it leaves a tombstone
// (deletedAt) so that the later sync with the server can tell "removed here" from "never saved here" and does not bring
// the bookmark back from another device. The newest change wins (see updatedAt). `snap` is a small copy of what the saved
// list needs to show the news without the network; it is local only and is never part of the sync.
export const BOOKMARKS_KEY = 'pnu.bookmarks.v1';
export const MAX_BOOKMARKS = 500;
export const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

// Keeps only the short text fields the saved list uses; anything else in a news item is left out.
export function cleanSnap(snap) {
  const clean = {
    title: text(snap?.title, 240),
    cover: text(snap?.cover, 600),
    color: text(snap?.color, 16),
    publishedAt: text(snap?.publishedAt, 40),
    unit: text(snap?.unit, 120),
    sourceUrl: text(snap?.sourceUrl, 600),
  };
  return Object.fromEntries(Object.entries(clean).filter(([, value]) => value));
}

export function snapFromItem(item) {
  return cleanSnap({
    title: item?.title,
    cover: item?.cover?.src,
    color: item?.cover?.dominant_color,
    publishedAt: item?.published_at,
    unit: item?.publisher_unit,
    sourceUrl: item?.source_url,
  });
}

// When the record last changed; the value the sync compares.
export const updatedAt = (record) => record.deletedAt ?? record.savedAt;

function toRecord(raw) {
  const id = Number(raw?.id);
  const savedAt = Number(raw?.savedAt);
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isFinite(savedAt) || savedAt <= 0) return null;
  const deletedAt = Number(raw.deletedAt);
  const record = { id, savedAt, deletedAt: Number.isFinite(deletedAt) && deletedAt > 0 ? deletedAt : null };
  if (record.deletedAt === null) record.snap = cleanSnap(raw.snap);
  return record;
}

/**
 * @param {object} [options]
 * @param {Storage|null} [options.storage] localStorage, or null/throwing when the browser blocks it: the bookmarks then
 *   live in memory until the page closes (see `persistent`).
 * @param {() => number} [options.now] clock in milliseconds, replaceable in tests
 * @param {number} [options.max] most live bookmarks
 */
export function createBookmarkStore({ storage = null, now = Date.now, max = MAX_BOOKMARKS, key = BOOKMARKS_KEY } = {}) {
  let records = new Map();
  let persistent = Boolean(storage);
  const listeners = new Set();

  function readStorage() {
    if (!storage) return records;
    let parsed = null;
    try { parsed = JSON.parse(storage.getItem(key) || 'null'); } catch { parsed = null; }
    const loaded = new Map();
    for (const raw of Array.isArray(parsed?.items) ? parsed.items : []) {
      const record = toRecord(raw);
      const previous = record ? loaded.get(record.id) : null;
      if (record && (!previous || updatedAt(record) > updatedAt(previous))) loaded.set(record.id, record);
    }
    for (const [id, record] of loaded) {
      if (record.deletedAt !== null && now() - record.deletedAt > TOMBSTONE_TTL_MS) loaded.delete(id);
    }
    return loaded;
  }

  function write() {
    if (!storage) { persistent = false; return; }
    try {
      storage.setItem(key, JSON.stringify({ v: 1, items: [...records.values()] }));
      persistent = true;
    } catch {
      persistent = false; // blocked or full: the change stays in memory for this visit
    }
  }

  function emit() {
    for (const listener of listeners) {
      try { listener(); } catch { /* a broken listener must not stop the others */ }
    }
  }

  // Every change starts from what is stored now, so a change made in another tab is not overwritten.
  function change(apply) {
    records = readStorage();
    const result = apply();
    if (result.changed) {
      write();
      emit();
    }
    return result;
  }

  const live = () => [...records.values()].filter((record) => record.deletedAt === null);

  records = readStorage();

  const store = {
    has(id) {
      return records.get(Number(id))?.deletedAt === null;
    },
    count: () => live().length,
    list: () => live().sort((a, b) => b.savedAt - a.savedAt),
    // Every record, tombstones included: what the sync sends.
    records: () => [...records.values()].map((record) => ({ ...record })),
    get persistent() { return persistent; },

    add(id, snap) {
      const number = Number(id);
      if (!Number.isSafeInteger(number) || number <= 0) return { ok: false, reason: 'invalid' };
      return change(() => {
        const existing = records.get(number);
        if (existing && existing.deletedAt === null) return { ok: true, saved: true, changed: false };
        if (live().length >= max) return { ok: false, reason: 'limit', changed: false };
        // Strictly later than anything this id had before, so re-saving right after removing still wins the sync.
        const savedAt = Math.max(now(), (existing?.savedAt ?? 0) + 1, (existing?.deletedAt ?? 0) + 1);
        records.set(number, { id: number, savedAt, deletedAt: null, snap: cleanSnap(snap) });
        return { ok: true, saved: true, changed: true };
      });
    },

    remove(id) {
      const number = Number(id);
      return change(() => {
        const existing = records.get(number);
        if (!existing || existing.deletedAt !== null) return { ok: true, saved: false, changed: false };
        records.set(number, { id: number, savedAt: existing.savedAt, deletedAt: Math.max(now(), existing.savedAt + 1) });
        return { ok: true, saved: false, changed: true };
      });
    },

    toggle(id, snap) {
      return store.has(id) ? store.remove(id) : store.add(id, snap);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    // Another tab changed the storage: take its version and tell the listeners.
    reload() {
      records = readStorage();
      emit();
    },
  };
  return store;
}
