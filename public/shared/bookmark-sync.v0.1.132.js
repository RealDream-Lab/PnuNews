// Keeps the bookmarks of a signed-in reader in step with the server. It has no imports on purpose: the page hands it the
// store, a `send(items)` that talks to /api/reader/bookmarks/sync, and a few callbacks, so it can be tested without a browser.
//
// The local bookmark is always written first and the page never waits for this: a sync starts shortly after a local change,
// after login, when the reader opens the site (start), when the connection comes back and when the page becomes visible
// again after a while. Everything the device has is sent each time; the answer is the merged truth, which is taken in only
// after it arrived, so a failed sync loses nothing. A failure is retried later, quietly, with growing pauses.
export const SYNC_DEBOUNCE_MS = 2000;
export const SYNC_REFRESH_MS = 5 * 60_000;
export const RETRY_STEPS_MS = [30_000, 60_000, 120_000, 300_000, 600_000];

/**
 * @param {object} options
 * @param {object} options.store the bookmark store (records, mergeRemote, subscribe)
 * @param {(items: object[]) => Promise<{ status: number, body: any }>} options.send resolves with the server's answer, rejects when the network failed
 * @param {() => boolean} options.isActive false while signup is switched off or nobody is signed in
 * @param {() => void} [options.onUnauthorized] the session is gone (401): the page should show the reader as signed out
 * @param {() => void} [options.onDisabled] the server says accounts are switched off (403)
 * @param {() => void} [options.onMerged] after the server's changes were taken in
 */
export function createBookmarkSync({
  store, send, isActive, onUnauthorized = () => {}, onDisabled = () => {}, onMerged = () => {},
  clock = Date.now, schedule = setTimeout, cancel = clearTimeout,
  events = globalThis.window, visibility = globalThis.document,
}) {
  let started = false;
  let timer = null;
  let running = false;
  let again = false;
  let failures = 0;
  let lastSyncAt = 0;
  let unsubscribe = null;

  function plan(delay) {
    if (!started) return;
    cancel(timer);
    timer = schedule(run, delay);
  }

  async function run() {
    timer = null;
    if (!started || !isActive()) return;
    if (running) { again = true; return; }
    running = true;
    try {
      const items = store.records().map((record) => ({ newsId: record.id, savedAt: record.savedAt, deletedAt: record.deletedAt }));
      const answer = await send(items);
      if (answer.status === 401) { onUnauthorized(); return; }
      if (answer.status === 403) { onDisabled(); return; }
      if (answer.status < 200 || answer.status >= 300 || !Array.isArray(answer.body?.items)) throw new Error('sync failed');
      store.mergeRemote(answer.body.items);
      failures = 0;
      lastSyncAt = clock();
      onMerged();
    } catch {
      failures += 1;
      plan(RETRY_STEPS_MS[Math.min(failures - 1, RETRY_STEPS_MS.length - 1)]);
    } finally {
      running = false;
      if (again) { again = false; plan(SYNC_DEBOUNCE_MS); }
    }
  }

  const onOnline = () => plan(1000);
  const onVisible = () => {
    if (visibility?.visibilityState === 'visible' && clock() - lastSyncAt > SYNC_REFRESH_MS) plan(500);
  };

  return {
    start() {
      if (started) return;
      started = true;
      // Only the reader's own changes are news to the server; taking in the server's answer or filling in a title is not.
      unsubscribe = store.subscribe(({ kind }) => { if (kind === 'local') plan(SYNC_DEBOUNCE_MS); });
      events?.addEventListener?.('online', onOnline);
      visibility?.addEventListener?.('visibilitychange', onVisible);
      plan(0);
    },
    stop() {
      started = false;
      cancel(timer);
      timer = null;
      again = false;
      failures = 0;
      unsubscribe?.();
      unsubscribe = null;
      events?.removeEventListener?.('online', onOnline);
      visibility?.removeEventListener?.('visibilitychange', onVisible);
    },
    syncNow() { plan(0); },
  };
}
