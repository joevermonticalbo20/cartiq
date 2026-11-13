import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "../components/Toast.jsx";
import { useLiveEvent, useLiveStatus } from "./useLiveStream.js";
import { alertLink, alertLinkLabel, toastedAlertIds } from "../utils/alertLinks.js";
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
export function useOrderNotifications({ onOrder, playSound, user } = {}) {
  const orderRef = useRef(onOrder);
  const soundRef = useRef(playSound);
  const navigate = useNavigate();
  // The SSE stream is the instant channel. Polling only runs while it is
  // down/paused, so a healthy live connection costs zero poll reads. On a
  // reconnect, run one catch-up poll: an order created during the short
  // disconnected gap is otherwise missed forever by the server-side cursor.
  const streamOpenRef = useRef(false);
  const wasOpenRef = useRef(false);
  const pollOnceRef = useRef(() => {});
  useLiveStatus((status) => {
    const open = status === "open";
    streamOpenRef.current = open;
    if (open && !wasOpenRef.current) {
      void Promise.resolve(pollOnceRef.current()).catch(() => {});
    }
    wasOpenRef.current = open;
  });

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

  // Dedupe across the two delivery paths (SSE + poll below): whichever fires
  // first wins, the second is dropped. Keyed by order id.
  const notifiedOrderIds = useRef(new Set());
  const seededRef = useRef(false);

  const notifyOrder = useCallback((data) => {
    const id = data?.id;
    if (id != null) {
      if (notifiedOrderIds.current.has(id)) return;
      notifiedOrderIds.current.add(id);
    }
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

  const handleOrder = useCallback((data) => {
    notifyOrder(data);
  }, [notifyOrder]);

  useLiveEvent("order:new", handleOrder);

  // Polling fallback: the live SSE stream can stay "Connecting" (ticket /
  // reconnect failure) while sales keep flowing. Polling the top orders page
  // every few seconds guarantees the toast + sound still fire, deduped
  // against the SSE path by order id. The first fetch only seeds the ids so
  // history never toasts on mount.
  useEffect(() => {
    let cancelled = false;
    // 3s keeps the order toast < 3s even when SSE is disconnected. The poll
    // is skipped while the tab is hidden, so there is no background cost.
    const POLL_MS = 3000;

    const mapOrderRow = (o) => ({
      id: o?.id,
      total: o?.total,
      locationCode: o?.location?.code ?? o?.locationCode ?? "",
      itemCount: Array.isArray(o?.items) ? o.items.length : (o?.itemCount ?? 0),
      staffName: o?.staff?.name ?? o?.staffName ?? null,
    });

    const poll = async ({ force = false } = {}) => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.hidden) return;
      if (!force && streamOpenRef.current) return; // SSE is delivering already (instant).
      try {
        const res = await api.get("/orders?page=1&pageSize=5");
        if (cancelled) return;
        const rows = Array.isArray(res.data?.data) ? res.data.data : [];
        // Only real sales toast; voided rows are history, not news.
        const fresh = rows
          .filter((o) => o && o.status !== "VOID")
          .map(mapOrderRow);
        if (!seededRef.current) {
          fresh.forEach((o) => {
            if (o.id != null) notifiedOrderIds.current.add(o.id);
          });
          seededRef.current = true;
          return;
        }
        // Orders without an id cannot be deduped; API rows always carry one,
        // so anything else is ignored rather than re-toast every poll.
        const unseen = fresh.filter(
          (o) => o.id != null && !notifiedOrderIds.current.has(o.id)
        );
        if (!unseen.length) return;
        unseen.sort((a, b) => Number(b.id ?? 0) - Number(a.id ?? 0));
        if (unseen.length === 1) {
          // notifyOrder dedupes AND marks; marking here first would make it
          // drop the toast itself.
          notifyOrder(unseen[0]);
          return;
        }
        // Offline queue syncing can land several sales at once: mark them all
        // (no per-order notify), then one sound + one summary toast describing
        // the latest instead of N toasts.
        unseen.forEach((o) => {
          if (o.id != null) notifiedOrderIds.current.add(o.id);
        });
        const latest = unseen[0];
        const notice = formatOrderNotice(latest);
        const link = "/sales";
        soundRef.current?.();
        toast(
          `${unseen.length} new orders. Latest: ${notice.message}`,
          "success",
          { onClick: () => navigate(link), title: "Go to sales" }
        );
        pushBrowserNotification(
          `${unseen.length} new orders`,
          notice.body,
          link
        );
        orderRef.current?.(latest);
      } catch {
        /* offline / 401 / network - SSE (if up) and the next poll still cover us */
      }
    };

    pollOnceRef.current = () => poll({ force: true });
    const t = setInterval(() => { void poll(); }, POLL_MS);
    void poll();
    return () => {
      cancelled = true;
      clearInterval(t);
      pollOnceRef.current = () => {};
    };
  }, [notifyOrder, navigate]);

  const handleAlert = useCallback((data) => {
    const type = String(data?.type ?? "").toUpperCase();
    const targetUserId = data?.userId == null ? null : Number(data.userId);
    const currentUserId = Number(user?.sub ?? user?.id);
    // VOID_DECISION and RESTOCK_UPDATE are notifications for the staff account
    // that requested the action. Toasting them on the owner's web shell would
    // duplicate the app notification and confuse the action owner.
    if (targetUserId != null && targetUserId !== currentUserId) return;
    if (
      user?.role === "OWNER" &&
      (type === "VOID_DECISION" || type === "RESTOCK_UPDATE")
    ) {
      return;
    }

    // One sale = one notification. `order:new` already raised the richer
    // toast (and browser notification) above; the SALE alert would only
    // duplicate it. The bell still shows the alert.
    if (isDuplicateSaleAlert(data)) return;
    // A recorded shift is already announced by `shift:new` (useShiftNotices).
    // The SHIFT alert is still fetched into the bell, so the toast must not
    // fire a second time. The bell still shows the alert.
    if (String(data?.type ?? "").toUpperCase() === "SHIFT") return;
    // A card registration is already announced by `rfid:bound` (useRfidEvents).
    // The RFID_BOUND alert is still fetched into the bell, so the toast must
    // not fire a second time. The bell still shows the alert.
    if (String(data?.type ?? "").toUpperCase() === "RFID_BOUND") return;
    // A card removal is already announced by `rfid:unbound` (useRfidEvents).
    if (String(data?.type ?? "").toUpperCase() === "RFID_UNBOUND") return;
    if (data?.id != null && toastedAlertIds.has(data.id)) return;
    if (data?.id != null) toastedAlertIds.add(data.id);
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
  }, [navigate, user]);

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