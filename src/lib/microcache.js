export function createMicroCache({ ttlMs = 15_000, maxEntries = 1000, clock = Date.now } = {}) {
  const entries = new Map();

  async function get(key, loader) {
    const now = clock();
    const cached = entries.get(key);
    if (cached && cached.expiresAt > now) {
      entries.delete(key);
      entries.set(key, cached);
      return cached.value;
    }
    if (cached) entries.delete(key);

    const valuePromise = Promise.resolve().then(loader);
    entries.set(key, { expiresAt: now + ttlMs, value: valuePromise });
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    try {
      const value = await valuePromise;
      const current = entries.get(key);
      if (current?.value === valuePromise) current.value = value;
      return value;
    } catch (error) {
      if (entries.get(key)?.value === valuePromise) entries.delete(key);
      throw error;
    }
  }

  function clear() {
    entries.clear();
  }

  return { get, clear };
}
