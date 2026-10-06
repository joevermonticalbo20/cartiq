import { useCallback, useState } from "react";
import { useLiveEvent } from "./useLiveStream.js";

/**
 * Recent `order:new` events for the topbar bell dropdown.
 *
 * Kept separate from the unread counter on purpose: the badge is a single
 * number persisted across navigation, while this is a short, session-scoped
 * feed the operator reads when they open the bell. A reload is a fresh start
 * for the feed (the badge survives; the list does not) which matches what a
 * bell is for - "what just happened", not "history".
 *
 * Capped so a burst cannot grow without bound in a long-lived dashboard.
 */

const MAX_ITEMS = 12;

function summarize(data) {
  const cart = data?.locationCode ?? "?";
  const total = Number(data?.total ?? 0);
  const items = Number(data?.itemCount ?? 0);
  return {
    key: `${data?.id ?? "?"}-${data?._time ?? Math.random()}`,
    id: data?.id ?? null,
    cart,
    total,
    items,
    staffName: data?.staffName ?? null,
    at: data?._time ?? new Date().toISOString(),
  };
}

/** Mount once in the app shell. Returns { items, clear }. */
export function useRecentOrders() {
  const [items, setItems] = useState([]);

  const push = useCallback((data) => {
    setItems((prev) => [summarize(data), ...prev].slice(0, MAX_ITEMS));
  }, []);

  const clear = useCallback(() => setItems([]), []);

  useLiveEvent("order:new", push);

  return { items, clear };
}

/**
 * Collapse a flat order feed into per-cart groups, newest group first.
 *
 * A busy service can produce several orders for the same cart in a minute.
 * Summarising them ("CART-01 - 3 orders - P240") is what an owner actually
 * wants at a glance, and it keeps the panel short instead of a scrolling wall
 * of near-identical rows. Exported separately so the arithmetic is unit tested.
 */
export function groupOrdersByCart(items) {
  const byCart = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const g = byCart.get(item.cart);
    if (g) {
      g.orders += 1;
      g.total += item.total;
      g.items += item.items;
      g.latestAt = item.at;
      g.latestKey = item.key;
      if (item.staffName) g.staffName = item.staffName;
    } else {
      byCart.set(item.cart, {
        cart: item.cart,
        orders: 1,
        total: item.total,
        items: item.items,
        staffName: item.staffName,
        latestAt: item.at,
        latestKey: item.key,
      });
    }
  }
  return [...byCart.values()].sort((a, b) => {
    const ta = Date.parse(a.latestAt);
    const tb = Date.parse(b.latestAt);
    return (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta);
  });
}

/** "2 min ago" style label. Pure so it can be unit tested. */
export function relativeTime(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "just now";
  const secs = Math.max(0, Math.floor((now - t) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.floor(hours / 24)} d ago`;
}