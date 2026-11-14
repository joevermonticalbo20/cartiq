import { useCallback, useEffect, useRef, useState } from "react";

import api from "../api.js";
import { clearApiCache } from "../apiCache.js";
import { onLiveEvent } from "../hooks/useLiveStream.js";

/**
 * One shared, live copy of every owner-facing list.
 *
 * The carts, the staff accounts and the readers used to be fetched separately
 * by each screen, so a change made in one tab left the other copies - and the
 * dropdowns built from them - stale until a reload. The Settings page even
 * held two different cart lists at once (the Carts table and the "Cart
 * assignment" dropdown), which is how a deactivated cart kept showing up in
 * the dropdown after the owner had deactivated it.
 *
 * One store per resource now:
 *
 *   - the first screen that mounts fetches it, the others share the result
 *   - a live frame ("locations:updated") refetches it for every screen at once
 *   - a mutation in another tab of the same browser refetches it too
 *     (BroadcastChannel - instant, and it costs the server nothing)
 *   - the short-lived GET cache is dropped before every refetch, so no screen
 *     can be served a stale copy
 *
 * The phone at the cart learns about the same changes through the data-only
 * push the server sends with every owner mutation.
 */

// key -> { data, error, loading, listeners: Set, promise }
const store = new Map();

/** The live frame that invalidates each list. */
export const LIVE_LIST_EVENTS = Object.freeze({
  carts: "locations:updated",
  staff: "staff:updated",
  devices: "devices:updated",
});

/**
 * The loaders.
 *
 * `carts` is the owner's list (every cart, with its status). A staff account
 * may not read it, so it falls back to the catalog's carts, which are the
 * active ones - exactly what a cart dropdown needs.
 */
const LOADERS = {
  carts: async () => {
    try {
      const { data } = await api.get("/locations");
      const list = data?.data ?? [];
      // A staff account may not read the owner's list, and an account with
      // no carts has nothing to show: the POS catalog lists the active carts
      // for everyone.
      if (list.length > 0) return list;
    } catch {
      // Not an owner: fall through to the catalog.
    }
    const { data } = await api.get("/catalog");
    return data?.locations ?? [];
  },
  staff: async () => {
    const { data } = await api.get("/auth/staff");
    return data?.data ?? [];
  },
  devices: async () => {
    const { data } = await api.get("/devices");
    return data?.data ?? [];
  },
};

function entryFor(key) {
  let entry = store.get(key);
  if (!entry) {
    // Every resource here is a list, so an empty list is the honest "not
    // loaded yet" value (a null would break the pages that map over it).
    entry = { data: [], error: null, loading: false, listeners: new Set(), promise: null, seq: 0 };
    store.set(key, entry);
  }
  return entry;
}

function publish(key) {
  const entry = entryFor(key);
  for (const listener of [...entry.listeners]) {
    try {
      listener({ data: entry.data, error: entry.error, loading: entry.loading });
    } catch {
      /* a broken subscriber must not break the store */
    }
  }
}

/** Fetch one list (once) and hand it to everyone who is waiting for it. */
export function loadLiveList(key, { force = false } = {}) {
  const loader = LOADERS[key];
  const entry = entryFor(key);
  if (!loader) return Promise.resolve(null);
  if (entry.promise && !force) return entry.promise;
  entry.loading = true;
  publish(key);
  // The GET cache is short-lived but real: drop it so a refetch never serves
  // the copy from before the change.
  clearApiCache();
  // Two loads can overlap (a live event lands while a fetch is running). Only
  // the newest answer may write, so a slow earlier request cannot put the old
  // list back on the screen.
  const seq = (entry.seq ?? 0) + 1;
  entry.seq = seq;
  entry.promise = loader()
    .then((data) => {
      if (entry.seq === seq) {
        entry.data = data;
        entry.error = null;
      }
      return data;
    })
    .catch((err) => {
      if (entry.seq === seq) entry.error = err;
      return entry.data;
    })
    .finally(() => {
      if (entry.seq === seq) {
        entry.loading = false;
        entry.promise = null;
        publish(key);
      }
    });
  return entry.promise;
}

/** Refetch a list now (e.g. after this tab made the change itself). */
export function invalidateLiveList(key) {
  return loadLiveList(key, { force: true });
}

/**
 * Test seam: drop every cached list.
 *
 * The store lives as long as the page, which is what the app wants (one
 * fetch, shared by every screen). A test file that renders the same page
 * twice needs a clean slate though.
 */
export function __resetLiveData() {
  store.clear();
}

/**
 * The carts a cart dropdown may offer.
 *
 * A deactivated cart disappears: it cannot be assigned to a reader or a
 * staff member any more. The cart that is currently chosen is always kept,
 * so an existing assignment never vanishes from an open form.
 */
export function activeCarts(carts, currentCode) {
  const list = Array.isArray(carts) ? carts : [];
  return list.filter((c) => c.status !== "INACTIVE" || c.code === currentCode);
}

/**
 * Read one live list.
 *
 * [key] is one of "carts", "staff", "devices". The hook returns the list plus
 * its loading/error state and a reload function.
 */
export function useLiveList(key, { enabled = true } = {}) {
  const entry = entryFor(key);
  const [state, setState] = useState(() => ({
    data: entry.data,
    error: entry.error,
    loading: entry.loading,
  }));
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    const listeners = entry.listeners;
    const listener = (next) => {
      if (!mounted.current) return;
      setState(next);
    };
    listeners.add(listener);
    loadLiveList(key);
    return () => {
      listeners.delete(listener);
    };
  }, [key, enabled, entry]);

  const reload = useCallback(() => invalidateLiveList(key), [key]);

  return { ...state, reload };
}

// --- the wiring: every change invalidates the list it belongs to ---

for (const [key, event] of Object.entries(LIVE_LIST_EVENTS)) {
  onLiveEvent(event, () => {
    invalidateLiveList(key);
  });
}

// The other tab of the same browser: the mutation already happened, so the
// change is known without asking the server. Instant, and it costs no reads.
if (typeof BroadcastChannel !== "undefined") {
  const channel = new BroadcastChannel("cartiq-data-changed");
  channel.addEventListener("message", (event) => {
    const kind = String(event?.data?.kind ?? "");
    const key = Object.keys(LIVE_LIST_EVENTS).find((k) => k === kind);
    if (key) invalidateLiveList(key);
  });
}
