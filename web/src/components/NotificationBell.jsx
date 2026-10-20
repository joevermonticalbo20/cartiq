import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, ShoppingBag, Volume2, VolumeX } from "lucide-react";
import { useNotificationBadge } from "../hooks/useNotificationBadge.js";
import { useRecentOrders, groupOrdersByCart, relativeTime } from "../hooks/useRecentOrders.js";
import { useOrderSound } from "../hooks/useOrderSound.js";
import { LIVE_EVENTS, useLiveEvent } from "../hooks/useLiveStream.js";
import api from "../api.js";

/**
 * Topbar order-notification bell.
 *
 * Shows an unread count while collapsed; opens a panel listing the orders that
 * arrived this session (cart, amount, item count, who rang it up). Opening the
 * panel marks everything read - the operator has now seen it - which is the
 * standard mail-client mental model and avoids a badge that never clears.
 */
export default function NotificationBell() {
  const { count, clear } = useNotificationBadge();
  const { items, clear: clearItems } = useRecentOrders();
  const { enabled: soundOn, setEnabled: setSoundOn, supported: soundSupported } = useOrderSound();
  const [open, setOpen] = useState(false);
  const [restockRequests, setRestockRequests] = useState([]);
  const [restockError, setRestockError] = useState("");
  const [updatingRequestId, setUpdatingRequestId] = useState(null);
  const ref = useRef(null);
  const buttonRef = useRef(null);
  const navigate = useNavigate();

  // One row per cart: a burst of orders for the same cart reads as one line.
  const groups = useMemo(() => groupOrdersByCart(items), [items]);
  const notificationCount = count + restockRequests.length;

  const receiveRestockRequest = useCallback((request) => {
    const requests = Array.isArray(request?.requests) ? request.requests : [request];
    const fresh = requests.filter((item) =>
      item?.id && ["pending", "acknowledged"].includes(item.status),
    );
    if (fresh.length === 0) return;
    setRestockError("");
    const freshIds = new Set(fresh.map((item) => item.id));
    setRestockRequests((previous) => [
      ...fresh,
      ...previous.filter((item) => !freshIds.has(item.id)),
    ]);
  }, []);

  const updateRestockRequest = useCallback(async (request, resolution) => {
    setUpdatingRequestId(request.id);
    try {
      await api.patch(`/alerts/${request.id}/restock-status`, {
        status: "fulfilled",
        resolution,
      });
      setRestockRequests((previous) =>
        previous.filter((item) => item.id !== request.id),
      );
    } catch {
      setRestockError("Unable to update the restock request. Try again.");
    } finally {
      setUpdatingRequestId(null);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    api.get("/inventory/restock-requests")
      .then((response) => {
        if (!mounted) return;
        setRestockRequests(response.data?.data ?? []);
        setRestockError("");
      })
      .catch(() => {
        if (mounted) setRestockError("Restock requests are temporarily unavailable.");
      });
    return () => {
      mounted = false;
    };
  }, []);

  useLiveEvent(LIVE_EVENTS.restockRequestNew, receiveRestockRequest);
  useLiveEvent(LIVE_EVENTS.restockRequestUpdated, (request) => {
    if (["pending", "acknowledged"].includes(request?.status)) {
      receiveRestockRequest(request);
    } else if (request?.id) {
      setRestockRequests((previous) =>
        previous.filter((item) => item.id !== request.id),
      );
    }
  });

  const close = useCallback(() => setOpen(false), []);

  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      // Opening the panel means the operator has read the notifications.
      if (next) {
        clear();
      }
      return next;
    });
  }, [clear]);

  // Close on outside click (same pattern as Select.jsx).
  useEffect(() => {
    if (!open) return undefined;
    function handleClickOutside(event) {
      if (ref.current && !ref.current.contains(event.target)) close();
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open, close]);

  // Escape closes and returns focus to the trigger, so keyboard users are not
  // stranded by a panel that overlays content.
  useEffect(() => {
    if (!open) return undefined;
    function onKey(e) {
      if (e.key === "Escape") {
        close();
        buttonRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  return (
    <div className="notif-wrap" ref={ref}>
      <button
        type="button"
        ref={buttonRef}
        className="ghost icon-only notif-btn"
        title={notificationCount > 0
          ? `${notificationCount} active notification${notificationCount === 1 ? "" : "s"}`
          : "Notifications"}
        aria-label={
          notificationCount > 0
            ? `Notifications: ${notificationCount} active`
            : "Notifications: none"
        }
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={toggle}
      >
        <Bell size={18} />
        {notificationCount > 0 && (
          <span className="notif-badge" aria-hidden="true">
            {notificationCount > 99 ? "99+" : notificationCount}
          </span>
        )}
      </button>

      {open && (
        <div className="notif-panel" role="dialog" aria-label="Notifications">
          <div className="notif-panel-head">
            <strong>Notifications</strong>
            <span className="notif-head-actions">
              {soundSupported && (
                <button
                  type="button"
                  className="notif-icon-btn"
                  title={soundOn ? "Mute order sound" : "Enable order sound"}
                  aria-label={soundOn ? "Mute order sound" : "Enable order sound"}
                  aria-pressed={soundOn}
                  onClick={() => setSoundOn(!soundOn)}
                >
                  {soundOn ? <Volume2 size={15} /> : <VolumeX size={15} />}
                </button>
              )}
              {items.length > 0 && (
                <button
                  type="button"
                  className="notif-clear"
                  onClick={() => {
                    clearItems();
                    clear();
                  }}
                >
                  Clear
                </button>
              )}
            </span>
          </div>

          {restockError && <p className="notif-empty" role="alert">{restockError}</p>}

          {restockRequests.length > 0 && (
            <>
              <div className="notif-panel-head">
                <strong>Restock requests</strong>
              </div>
              <ul className="notif-list">
                {restockRequests.map((request) => (
                  <li key={request.id} className="notif-item notif-request">
                    <span className="notif-item-icon" aria-hidden="true">
                      <ShoppingBag size={14} />
                    </span>
                    <span className="notif-item-body">
                      <span className="notif-item-title">
                        <strong>{request.ingredientName ?? "Ingredient"}</strong>
                        <span className={`chip ${request.urgency === "critical" ? "critical" : request.urgency === "urgent" ? "low" : "info"}`}>
                          {String(request.urgency ?? "normal").toUpperCase()}
                        </span>
                      </span>
                      <span className="notif-item-meta">
                        {request.locationCode ?? "Cart"} · {request.requestedByName ?? "Staff"}
                        {request.notes ? ` · ${request.notes}` : ""}
                      </span>
                      <span className="notif-head-actions" style={{ marginTop: 8 }}>
                        <button
                          type="button"
                          className="small-btn"
                          disabled={updatingRequestId === request.id}
                          onClick={() => updateRestockRequest(request, "restocked")}
                        >
                          Mark Restocked
                        </button>
                        <button
                          type="button"
                          className="danger-ghost small-btn"
                          disabled={updatingRequestId === request.id}
                          onClick={() => updateRestockRequest(request, "dismissed")}
                        >
                          Dismiss
                        </button>
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {items.length === 0 && restockRequests.length === 0 ? (
            <p className="notif-empty">No orders yet this session.</p>
          ) : items.length > 0 && (
            <ul className="notif-list">
              {groups.map((g) => (
                <li key={g.latestKey}>
                  {/* A whole-row button, not a <div onClick>: gives keyboard
                      activation and the correct role for free. Stays a <li> so
                      the list semantics survive. */}
                  <button
                    type="button"
                    className="ghost notif-item"
                    title={`Open Sales filtered to ${g.cart}`}
                    onClick={() => {
                      // Land on Sales pre-filtered to this cart: that is the
                      // only place the order rows live, and the cart code is
                      // the one piece of context the operator is missing.
                      close();
                      navigate(`/sales?cart=${encodeURIComponent(g.cart)}`);
                    }}
                  >
                    <span className="notif-item-icon" aria-hidden="true">
                      <ShoppingBag size={14} />
                    </span>
                    <span className="notif-item-body">
                      <span className="notif-item-title">
                        <strong>{g.cart}</strong>
                        <span className="notif-item-total">
                          ₱{g.total.toLocaleString("en-PH", { minimumFractionDigits: 2 })}
                        </span>
                      </span>
                      <span className="notif-item-meta">
                        {g.orders} order{g.orders === 1 ? "" : "s"} · {g.items} item
                        {g.items === 1 ? "" : "s"}
                        {g.staffName ? ` · ${g.staffName}` : ""} · {relativeTime(g.latestAt)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}