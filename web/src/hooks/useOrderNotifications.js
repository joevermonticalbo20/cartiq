import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "../components/Toast.jsx";
import { useLiveEvent } from "./useLiveStream.js";
import { alertLink, alertLinkLabel } from "../utils/alertLinks.js";
import api from "../api.js";

/**
 * Turns live `order:new` / `alert:new` stream events into notifications the
 * operator actually notices.
 *
 * Two layers, on purpose:
 *   1. An in-app toast - works everywhere in the dashboard.
 *   2. A browser Notification - the only thing visible when the tab is in the
 *      background, which is the normal state while the phone is running a
 *      sale and the owner is looking at something else.
 *
 * These deliberately ignore the Dashboard's date/cart filters. The old code
 * dropped an event entirely when a past date or another cart was selected, so
 * a live sale could happen silently. Filters should narrow the KPI panel, not
 * hide the fact that money moved. The cart code is in the message instead, so
 * the owner still learns WHICH cart rang up.
 */

/** Ask for notification permission once, silently. Never blocks the UI. */
function ensurePermission() {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  try {
    if (Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  } catch {
    /* unsupported / blocked - the in-app toast still covers us */
  }
}

function pushBrowserNotification(title, body, link) {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, {
      body,
      // `tag` collapses a burst of orders for the same cart into one entry
      // instead of stacking N system notifications.
      tag: "cartiq-live",
      renotify: false,
    });
    n.onclick = () => {
      try {
        window.focus();
      } catch {
        /* focus can be blocked; nothing else to do */
      }
      // Same target as the in-app toast: the page the notification is about.
      try {
        if (link) window.location.assign(link);
      } catch {
        /* location.assign can be blocked; window focus is still useful */
      }
      n.close();
    };
  } catch {
    /* some browsers throw on the constructor; toast is the fallback */
  }
}

function money(value) {
  const n = Number(value ?? 0);
  return `₱${n.toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Pure formatter for one `order:new` event. Exported so the wording - the part
 * the operator actually reads - is unit tested instead of eyeballed.
 */
export function formatOrderNotice(data) {
  const cart = data?.locationCode ?? "?";
  const total = money(data?.total);
  const items = Number(data?.itemCount ?? 0);
  const itemWord = items === 1 ? "item" : "items";
  const who = data?.staffName ? ` - ${data.staffName}` : "";
  return {
    title: `New order on ${cart}`,
    body: `${total} - ${items} ${itemWord}${who}`,
    message: `New order on ${cart} - ${total} (${items} ${itemWord})${who}`,
  };
}

/**
 * A sale emits TWO stream events: `order:new` (cart, total, items, staff) and
 * a persisted `alert:new` with type SALE. Toasting both stacks two boxes for
 * one sale, so the SALE alert stays in the bell only. Every other alert type
 * has no order event and keeps its toast.
 */
export function isDuplicateSaleAlert(alert) {
  const type = String(alert?.type ?? "").toLowerCase();
  return type === "sale" || type === "sales";
}

/**
 * Mount once in the app shell. Notifies on every order regardless of the
 * current page or filters.
 */
export function useOrderNotifications({ onOrder, playSound } = {}) {
  const orderRef = useRef(onOrder);
  const soundRef = useRef(playSound);
  const navigate = useNavigate();

  // Ref writes belong in effects, not during render (react-hooks/refs).
  useLayoutEffect(() => {
    orderRef.current = onOrder;
  }, [onOrder]);

  useLayoutEffect(() => {
    soundRef.current = playSound;
  }, [playSound]);

  useEffect(() => {
    ensurePermission();
  }, []);

  const handleOrder = useCallback((data) => {
    const notice = formatOrderNotice(data);
    const cart = data?.locationCode ?? "";
    const link = cart ? `/sales?cart=${encodeURIComponent(cart)}` : "/sales";

    // Audible first: on a busy counter the operator may be looking away from
    // the monitor, and a sound is what they actually notice.
    soundRef.current?.();
    toast(notice.message, "success", {
      onClick: () => navigate(link),
      title: "Go to sales",
    });
    pushBrowserNotification(notice.title, notice.body, link);

    // Let the Dashboard bump its KPI counters without owning the connection.
    orderRef.current?.(data);
  }, [navigate]);

  useLiveEvent("order:new", handleOrder);

  const handleAlert = useCallback((data) => {
    // One sale = one notification. `order:new` already raised the richer
    // toast (and browser notification) above; the SALE alert would only
    // duplicate it. The bell still shows the alert.
    if (isDuplicateSaleAlert(data)) return;
    const message = data?.message ?? "New alert";
    const link = alertLink(data);
    toast(`Alert: ${message}`, "warn", {
      onClick: () => {
        if (data?.id != null) {
          // The toast is the operator clearing this item from the bell too.
          api.patch(`/alerts/${data.id}/read`).catch(() => {});
        }
        navigate(link);
      },
      title: alertLinkLabel(data),
    });
    pushBrowserNotification("CartIQ alert", message, link);
  }, [navigate]);

  useLiveEvent("alert:new", handleAlert);
}

/** True when the browser can show system notifications right now. */
export function browserNotificationsEnabled() {
  if (typeof window === "undefined" || !("Notification" in window)) return false;
  return Notification.permission === "granted";
}

/** Explicit opt-in, for a settings row. Must be called from a user gesture. */
export async function requestNotificationPermission() {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  try {
    const result = await Notification.requestPermission();
    return result;
  } catch {
    return "denied";
  }
}