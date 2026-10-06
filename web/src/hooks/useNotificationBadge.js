import { useCallback, useEffect, useState } from "react";
import { useLiveEvent } from "./useLiveStream.js";

/**
 * Unread badge for the topbar bell.
 *
 * Orders arrive while the owner is on any screen, so the count lives here
 * rather than in a page component. It is persisted to localStorage because the
 * shell survives client-side navigation: without persistence, moving from
 * Dashboard to Sales would silently drop the unread count.
 *
 * Cap the stored value at 99+ so a burst of orders cannot render a four-digit
 * bubble over the 44px icon.
 */

const STORAGE_KEY = "cartiq_unread_orders";
const MAX = 99;

function readStored() {
  try {
    const raw = Number(localStorage.getItem(STORAGE_KEY) ?? "0");
    return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), MAX) : 0;
  } catch {
    return 0;
  }
}

function writeStored(value) {
  try {
    localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    /* private mode / quota - the in-memory count still works */
  }
}

/** Mount once in the app shell. Returns { count, clear }. */
export function useNotificationBadge() {
  const [count, setCount] = useState(readStored);

  const bump = useCallback(() => {
    setCount((prev) => {
      const next = Math.min(prev + 1, MAX);
      writeStored(next);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setCount(0);
    writeStored(0);
  }, []);

  // Another tab (or a reload) already holds unread orders: pick that up too.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key !== STORAGE_KEY) return;
      setCount(readStored());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useLiveEvent("order:new", bump);

  return { count, clear };
}