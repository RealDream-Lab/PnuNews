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

export const MAX_ADDRESS_LENGTH = 2000;
// Older versions cut every address at 600 characters. An address of exactly that length is a cut one (see addressText).
const OLD_CUT_LENGTH = 600;

// An address is kept whole or not at all. Cut in the middle it is a different address: a «%» left over from «%D8%A7» once
// opened the wrong page. So an address that is too long, has a half percent-sequence, contains a space or is not an address
// is left out, never shortened. `secureOnly`: https only (what a card opens). `relative`: a path on this site also counts
// (the cover pictures).
function addressText(value, { relative = false, secureOnly = false } = {}) {
  if (typeof value !== 'string') return '';
  const address = value.trim();
  if (!address || address.length > MAX_ADDRESS_LENGTH || address.length === OLD_CUT_LENGTH || /\s/.test(address) || /%(?![0-9a-f]{2})/i.test(address)) return '';
  if (relative && address.startsWith('/') && !address.startsWith('//')) return address;
  if (!(secureOnly ? /^https:\/\//i : /^https?:\/\//i).test(address)) return '';
  try { new URL(address); } catch { return ''; }
  return address;
}

// 'external': the card opens the original article (portal news); 'internal': it opens the page of this site. Missing: not
// known (a bookmark from an older version, or one whose address was cut), so the server is asked when it is opened.
const LINKS = new Set(['external', 'internal']);

// Keeps only the short text fields the saved list uses; anything else in a news item is left out.
export function cleanSnap(snap) {
  const clean = {
    title: text(snap?.title, 240),
    summary: text(snap?.summary, 300),
    cover: addressText(snap?.cover, { relative: true }),
    color: text(snap?.color, 16),
    publishedAt: text(snap?.publishedAt, 40),
    unit: text(snap?.unit, 120),
    sourceUrl: addressText(snap?.sourceUrl, { secureOnly: true }),
    link: LINKS.has(snap?.link) ? snap.link : '',
  };
  return Object.fromEntries(Object.entries(clean).filter(([, value]) => value));
}

export function snapFromItem(item) {
  const external = typeof item?.source_url === 'string' && item.source_url.startsWith('https://');
  return cleanSnap({
    link: external ? 'external' : 'internal',
    title: item?.title,
    summary: item?.summary,
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

  // kind tells the listeners what happened: 'local' (this reader saved or removed something), 'merge' (the server's
  // changes were taken in), 'snap' (a local copy of a news was filled in) or 'reload' (another tab changed the storage).
  // Only 'local' is something the server has not heard of yet.
  function emit(kind) {
    for (const listener of listeners) {
      try { listener({ kind }); } catch { /* a broken listener must not stop the others */ }
    }
  }

  // Every change starts from what is stored now, so a change made in another tab is not overwritten.
  function change(apply, kind = 'local') {
    records = readStorage();
    const result = apply();
    if (result.changed) {
      write();
      emit(kind);
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
      emit('reload');
    },

    // The server's answer to a sync: [{ newsId, savedAt, deletedAt }]. The newest change of each news wins and a tie keeps
    // the local record, the same rule the server applies. A bookmark that came from another device has no local copy of the
    // news yet (see needSnapshots).
    mergeRemote(items) {
      return change(() => {
        let changed = false;
        for (const raw of Array.isArray(items) ? items : []) {
          const id = Number(raw?.newsId);
          const savedAt = Number(raw?.savedAt);
          if (!Number.isSafeInteger(id) || id <= 0 || !Number.isFinite(savedAt) || savedAt <= 0) continue;
          const deletedAt = Number(raw.deletedAt) > 0 ? Number(raw.deletedAt) : null;
          const local = records.get(id);
          if (local && updatedAt(local) >= (deletedAt ?? savedAt)) continue;
          records.set(id, deletedAt === null ? { id, savedAt, deletedAt: null, snap: local?.snap ?? {} } : { id, savedAt, deletedAt });
          changed = true;
        }
        return { ok: true, changed };
      }, 'merge');
    },

    // Adds to the local copy of one bookmark (the address of a portal news, what kind of news it is) once it is known.
    patchSnap(id, patch) {
      return change(() => {
        const record = records.get(Number(id));
        if (!record || record.deletedAt !== null) return { ok: true, changed: false };
        const merged = cleanSnap({ ...record.snap, ...patch });
        if (JSON.stringify(merged) === JSON.stringify(record.snap)) return { ok: true, changed: false };
        record.snap = merged;
        return { ok: true, changed: true };
      }, 'snap');
    },

    // Ids of the live bookmarks that have nothing to show yet (they came from another device), except `skip`.
    needSnapshots(skip = new Set()) {
      return live().filter((record) => !record.snap?.title && !record.snap?.summary && !skip.has(record.id)).map((record) => record.id);
    },

    // snaps: Map of id -> snapshot. Fills only the bookmarks that have nothing yet.
    setSnaps(snaps) {
      return change(() => {
        let changed = false;
        for (const [id, snap] of snaps) {
          const record = records.get(Number(id));
          if (!record || record.deletedAt !== null || record.snap?.title || record.snap?.summary) continue;
          const clean = cleanSnap(snap);
          if (!clean.title && !clean.summary) continue;
          record.snap = clean;
          changed = true;
        }
        return { ok: true, changed };
      }, 'snap');
    },
  };
  return store;
}
