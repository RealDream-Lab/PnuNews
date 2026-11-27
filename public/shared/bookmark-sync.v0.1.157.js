// Keeps the bookmarks of a signed-in reader in step with the server. It has no imports on purpose: the page hands it the
// store, a `send(items)` that talks to /api/reader/bookmarks/sync, and a few callbacks, so it can be tested without a browser.
//
// The local bookmark is always written first and the page never waits for this. A sync starts shortly after a local change,
// after login, when the reader opens the site (start), when the connection comes back, when the page or window gets the
// reader's attention again after a short while, and every two minutes while the page is visible, so an open page learns of
// what the reader did on another device without a refresh. With changes to send, everything the device has is sent and the
// answer is the merged truth; with nothing to send, the server's list is only fetched (cheaper). Either way the answer is taken
// in only after it arrived, so a failed sync loses nothing. A failure is retried later, quietly, with growing pauses.
export const SYNC_DEBOUNCE_MS = 2000;
export const SYNC_REFRESH_MS = 20_000;
export const SYNC_POLL_MS = 2 * 60_000;
export const RETRY_STEPS_MS = [30_000, 60_000, 120_000, 300_000, 600_000];

/**
 * @param {object} options
 * @param {object} options.store the bookmark store (records, mergeRemote, subscribe)
 * @param {(items: object[]) => Promise<{ status: number, body: any }>} options.send sends the device's bookmarks, resolves with the server's answer, rejects when the network failed
 * @param {() => Promise<{ status: number, body: any }>} [options.pull] only fetches the server's list (used when the device has nothing new to send)
 * @param {() => boolean} options.isActive false while signup is switched off or nobody is signed in
 * @param {() => void} [options.onUnauthorized] the session is gone (401): the page should show the reader as signed out
 * @param {() => void} [options.onDisabled] the server says accounts are switched off (403)
 * @param {() => void} [options.onMerged] after the server's changes were taken in
 */
export function createBookmarkSync({
  store, send, pull = null, isActive, onUnauthorized = () => {}, onDisabled = () => {}, onMerged = () => {},
  clock = Date.now, schedule = setTimeout, cancel = clearTimeout, pollMs = SYNC_POLL_MS,
  events = globalThis.window, visibility = globalThis.document,
}) {
  let started = false;
  let timer = null;
  let running = false;
  let again = false;
  let failures = 0;
  let lastSyncAt = 0;
  let unsubscribe = null;
  let pollTimer = null;
  let dirty = true; // the device may have something the server has not heard of (true until a send has gone through)
  let generation = 0; // counts the reader's own changes, to tell whether one came in while a sync was out

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
    const startedAt = generation;
    const sending = dirty || !pull;
    try {
      const items = store.records().map((record) => ({ newsId: record.id, savedAt: record.savedAt, deletedAt: record.deletedAt }));
      const answer = sending ? await send(items) : await pull();
      if (answer.status === 401) { onUnauthorized(); return; }
      if (answer.status === 403) { onDisabled(); return; }
      if (answer.status < 200 || answer.status >= 300 || !Array.isArray(answer.body?.items)) throw new Error('sync failed');
      store.mergeRemote(answer.body.items);
      if (sending && generation === startedAt) dirty = false;
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

  function schedulePoll() {
    cancel(pollTimer);
    pollTimer = schedule(() => {
      pollTimer = null;
      if (!started) return;
      if (visibility?.visibilityState !== 'hidden') plan(0); // a page in the background does not ask
      schedulePoll();
    }, pollMs);
  }

  const onOnline = () => plan(1000);
  const onAttention = () => {
    if (visibility?.visibilityState !== 'hidden' && clock() - lastSyncAt > SYNC_REFRESH_MS) plan(500);
  };

  return {
    start() {
      if (started) return;
      started = true;
      // Only the reader's own changes are news to the server; taking in the server's answer or filling in a title is not.
      unsubscribe = store.subscribe(({ kind }) => {
        if (kind !== 'local') return;
        generation += 1;
        dirty = true;
        plan(SYNC_DEBOUNCE_MS);
      });
      events?.addEventListener?.('online', onOnline);
      events?.addEventListener?.('focus', onAttention);
      visibility?.addEventListener?.('visibilitychange', onAttention);
      schedulePoll();
      plan(0);
    },
    stop() {
      started = false;
      cancel(timer);
      cancel(pollTimer);
      timer = null;
      pollTimer = null;
      again = false;
      failures = 0;
      dirty = true; // the next start begins with a full sync
      unsubscribe?.();
      unsubscribe = null;
      events?.removeEventListener?.('online', onOnline);
      events?.removeEventListener?.('focus', onAttention);
      visibility?.removeEventListener?.('visibilitychange', onAttention);
    },
    syncNow() { plan(0); },
  };
}
