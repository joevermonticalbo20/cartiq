import { useEffect, useRef } from "react";
import api from "../api.js";

/**
 * The catalog-version probe: the safety net under the live stream.
 *
 * Why it exists: the SSE stream is paused while the tab is hidden (to stop
 * burning the Firestore read budget on a tab nobody looks at) and the Edge
 * function only re-emits what it polls for. A change made while the tab was
 * hidden can therefore never reach the page. The POS app already solves this
 * with the same endpoint: one tiny read every 30s, and a full refetch only
 * when the version actually moved.
 *
 * The probe is a singleton (module level): one timer per tab, not one per
 * page. It stops when the last subscriber unmounts.
 *
 * The first probe only adopts the current version - it never fires, because
 * the page has just loaded the same data itself.
 */
const POLL_MS = 30000;

let lastVersion = null;
let timer = null;
const subscribers = new Set();

async function probe() {
  try {
    const res = await api.get("/catalog/version", { cacheTtl: 0 });
    const version = Number(res.data?.version);
    if (!Number.isFinite(version)) return;
    if (lastVersion === null) {
      lastVersion = version;
      return;
    }
    if (version === lastVersion) return;
    lastVersion = version;
    for (const fn of [...subscribers]) {
      try {
        fn(version);
      } catch {
        /* one bad subscriber must not stop the others */
      }
    }
  } catch {
    /* offline or transient: the next tick retries */
  }
}

function onWake() {
  if (typeof document !== "undefined" && document.hidden) return;
  void probe();
}

function ensureRunning() {
  if (timer !== null) return;
  timer = setInterval(() => { void probe(); }, POLL_MS);
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
  }
  void probe();
}

function stopIfIdle() {
  if (subscribers.size > 0 || timer === null) return;
  clearInterval(timer);
  timer = null;
  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", onWake);
    window.removeEventListener("focus", onWake);
  }
}

/**
 * Call `onChange` when the catalog version moved (a product, recipe, price or
 * stock row changed somewhere else). The handler is read through a ref, so it
 * may change every render without resubscribing.
 */
export function useCatalogVersion(onChange) {
  const handlerRef = useRef(onChange);

  useEffect(() => {
    handlerRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const wrapped = (version) => handlerRef.current?.(version);
    subscribers.add(wrapped);
    ensureRunning();
    return () => {
      subscribers.delete(wrapped);
      stopIfIdle();
    };
  }, []);
}

// Test seam: forget the version we last saw (the probe keeps module state, so
// a test would otherwise see the version of the previous test).
export function __resetCatalogVersionProbe() {
  lastVersion = null;
}

export default useCatalogVersion;
