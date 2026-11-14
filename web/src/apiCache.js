// The dashboard's short-lived GET cache.
//
// Same-origin reference data (the catalog, the carts) is fetched on nearly
// every page mount; a 60s client cache makes page switches feel instant. Any
// successful mutation (POST/PATCH/PUT/DELETE) clears the whole cache so
// edits, adds, and voids can never serve stale reads past one TTL window.
//
// It lives in its own module so that code outside api.js (the live store)
// can drop it without importing the whole HTTP client - and so a test that
// mocks api.js still gets the real cache behaviour.

const _getCache = new Map();

export function clearApiCache() {
  _getCache.clear();
}

export function cacheKey(options) {
  return `${String(options?.method ?? "GET").toUpperCase()}|${String(options?.url ?? "")}|${JSON.stringify(options?.params ?? null)}`;
}

/** The cached response for [key], or null when there is none (or it expired). */
export function readCached(key) {
  const hit = _getCache.get(key);
  if (!hit) return null;
  if (hit.exp > Date.now()) return hit.data;
  _getCache.delete(key);
  return null;
}

/** Remember a response for [ttlMs]. */
export function writeCached(key, ttlMs, data) {
  _getCache.set(key, { exp: Date.now() + ttlMs, data });
}
