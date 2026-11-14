import { useState, useRef, useEffect, useCallback } from "react";
import { Bell, Check, PackageSearch, ReceiptText, AlertTriangle, Info, ChevronRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import api from "../api.js";
import { useLiveEvent } from "../hooks/useLiveStream.js";
import { alertLink, alertLinkLabel, isSelfAnnouncedAlert, toastedAlertIds } from "../utils/alertLinks.js";
import { onBellRefresh } from "../utils/notificationBus.js";
import { useToast } from "../components/Toast.jsx";

/** Unread is `isRead` from the API (a.status only exists on restock rows). */
// eslint-disable-next-line react-refresh/only-export-components -- pure helper colocated with its only consumer, unit-tested in place
export const isUnreadAlert = (a) =>
  Boolean(a) && a.isRead !== true && a.status !== "read";

// Helper para sa "1h ago", "2m ago" format
function timeAgo(dateString) {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return "Just now";
  const diffMins = Math.floor((new Date() - date) / 60000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  return `${Math.floor(diffHrs / 24)}d ago`;
}

export default function NotificationBell() {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [alerts, setAlerts] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [activeTab, setActiveTab] = useState("All");
  const ref = useRef(null);
  const navigate = useNavigate();

  const activeRef = useRef(true);
  const refreshTimer = useRef(null);

  const seenIdsRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const res = await api.get("/alerts?page=1&pageSize=30");
      if (!activeRef.current) return;
      const data = res.data?.data || [];

      // Toast newly arrived unread alerts even when the live SSE event was
      // missed (tab hidden, dropped connection). The first load is silent so
      // historical alerts don't spam on every page refresh.
      const isFirst = seenIdsRef.current === null;
      const seen = seenIdsRef.current ?? new Set();
      if (!isFirst) {
        for (const a of data) {
          if (!isUnreadAlert(a) || seen.has(a.id) || toastedAlertIds.has(a.id)) continue;
          toastedAlertIds.add(a.id);
          const type = String(a.type ?? "").toLowerCase();
          if (type === "sale" || type === "sales") continue; // already toasted as an order
          // A shift, a card registration and a card removal each raise their
          // own live toast. The alert behind them still shows in the bell -
          // that is the point - but the bell must not say it a second time.
          if (isSelfAnnouncedAlert(a)) continue;
          const message = a.message || "New alert";
          const link = alertLink(a);
          toast(`Alert: ${message}`, "warn", {
            onClick: () => {
              if (a.id != null) api.patch(`/alerts/${a.id}/read`).catch(() => {});
              navigate(link);
            },
            title: alertLinkLabel(a),
          });
        }
      }
      seenIdsRef.current = new Set(data.map((a) => a.id));

      setAlerts(data);
      setUnreadCount(data.filter(isUnreadAlert).length);
    } catch {
      // Background fetch, ignore errors
    }
  }, [navigate, toast]);

  useEffect(() => {
    activeRef.current = true;
    const timer = setTimeout(refresh, 0);
    const interval = setInterval(() => {
      if (activeRef.current) refresh();
    }, 15000);
    return () => {
      activeRef.current = false;
      clearTimeout(timer);
      clearInterval(interval);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [refresh]);

  // One live refresh serves sales AND alerts: the API writes a SALE alert on
  // every order, so both events land on the same query. Debounced because an
  // Edge stream poll can deliver a burst of events at once.
  const liveRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      refresh();
    }, 600);
  }, [refresh]);

  // A recorded shift (time in / time out) creates a SHIFT alert. Refetch on the
  // same event the dashboard toasts on, so the notification center and the
  // toast land at the same time instead of the bell missing the new entry.
  useLiveEvent("alert:new", liveRefresh);
  useLiveEvent("shift:new", liveRefresh);
  useLiveEvent("order:new", liveRefresh);

  // The toast and the record must land together. A hook that raises a toast
  // (a recorded shift, a card registration) asks the bell to fetch at once,
  // so the entry shows up in the notification center in the same moment -
  // not a debounce later.
  useEffect(() => onBellRefresh(() => refresh()), [refresh]);

  const closePanel = () => {
    setIsClosing(true);
    setTimeout(() => {
      setOpen(false);
      setIsClosing(false);
    }, 150);
  };

  const toggleOpen = () => {
    if (open) closePanel();
    else setOpen(true);
  };

  useEffect(() => {
    function handleClickOutside(event) {
      if (ref.current && !ref.current.contains(event.target)) {
        setOpen((currentOpen) => {
          if (currentOpen) {
            setIsClosing(true);
            setTimeout(() => {
              setOpen(false);
              setIsClosing(false);
            }, 150);
          }
          return currentOpen;
        });
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  async function markAllAsRead() {
    try {
      await api.patch("/alerts/read");
      setAlerts(alerts.map(a => ({ ...a, status: "read", isRead: true })));
      setUnreadCount(0);
    } catch {
      // Background action
    }
  }

  // Opening an item marks it read and takes the operator to the page it
  // concerns. Optimistic; the PATCH is best-effort and the next refresh
  // reconciles either way.
  function goToAlert(alert) {
    const target = alertLink(alert);
    closePanel();
    navigate(target);
    if (isUnreadAlert(alert)) {
      setAlerts((current) => current.map((a) => (a.id === alert.id ? { ...a, isRead: true } : a)));
      setUnreadCount((n) => Math.max(0, n - 1));
      api.patch(`/alerts/${alert.id}/read`).catch(() => {});
    }
  }

  // Dynamic indicator theme (Icon, Color, Background). Types arrive in
  // UPPER_CASE from the API (SALE, LOW_STOCK, RESTOCK_REQUEST).
  const getTheme = (type) => {
    const t = String(type ?? "").toLowerCase();
    if (t === "restock" || t === "restock_request" || t === "inventory" || t === "low_stock") {
      return { icon: PackageSearch, color: "var(--warn)", bg: "var(--warn-bg)" };
    }
    if (t === "sale" || t === "sales") {
      return { icon: ReceiptText, color: "var(--success)", bg: "var(--success-bg)" };
    }
    if (t === "critical") {
      return { icon: AlertTriangle, color: "var(--danger)", bg: "var(--danger-bg)" };
    }
    return { icon: Info, color: "var(--info)", bg: "var(--info-bg)" };
  };

  const displayAlerts = alerts.filter(a => {
    if (activeTab === "Unread") return isUnreadAlert(a);
    if (activeTab === "Sales") {
      const t = String(a.type ?? "").toLowerCase();
      return t === "sale" || t === "sales" ||
        (a.message && a.message.toLowerCase().includes("sale"));
    }
    return true;
  }).slice(0, 15);

  return (
    <div className="notif-wrap" ref={ref}>
      <button
        className={`ghost icon-only notif-btn ${open ? "active" : ""}`}
        onClick={toggleOpen}
        aria-label="Notifications"
        aria-expanded={open}
      >
        <Bell size={18} />
        {unreadCount > 0 && <span className="notif-badge">{unreadCount > 9 ? "9+" : unreadCount}</span>}
      </button>

      {open && (
        <div className={`notif-panel ${isClosing ? "is-closing" : ""}`}>
          
          {/* Header */}
          <div className="notif-panel-head">
            <span style={{ fontSize: "16px", fontWeight: "700", color: "var(--text)" }}>Notification Center</span>
            <div className="flex gap-2">
               {unreadCount > 0 && (
                 <button className="notif-clear-icon" onClick={markAllAsRead} title="Mark all as read">
                   <Check size={16} />
                 </button>
               )}
               <button 
                 className="notif-see-all" 
                 onClick={() => { closePanel(); navigate("/notifications"); }}
               >
                 See All
               </button>
            </div>
          </div>

          {/* Segmented Control Tabs */}
          <div className="notif-tabs-wrapper">
            <div className="notif-tabs">
              {["All", "Unread", "Sales"].map(tab => (
                <button 
                  key={tab}
                  className={`notif-tab-btn ${activeTab === tab ? "active" : ""}`}
                  onClick={() => setActiveTab(tab)}
                >
                  {tab}
                </button>
              ))}
            </div>
          </div>

          {/* List Area */}
          <div className="notif-list-container">
            {displayAlerts.length === 0 ? (
              <p className="notif-empty">
                {activeTab === "All"
                  ? "No notifications yet"
                  : `No ${activeTab.toLowerCase()} notifications`}
              </p>
            ) : (
              <ul className="notif-list">
                {displayAlerts.map((alert) => {
                  const theme = getTheme(alert.type);
                  const Icon = theme.icon;

                  return (
                    <li key={alert.id}>
                      <button
                        type="button"
                        className="notif-item notif-item-btn"
                        onClick={() => goToAlert(alert)}
                        title={alertLinkLabel(alert)}
                        aria-label={`${alert.title || "Notification"}: ${alert.message}. ${alertLinkLabel(alert)}`}
                      >
                        {/* DYNAMIC INDICATOR */}
                        <div
                          className="notif-icon-circle"
                          style={{
                            color: theme.color,
                            backgroundColor: theme.bg,
                            borderColor: `color-mix(in srgb, ${theme.color} 30%, transparent)`
                          }}
                        >
                          <Icon size={16} />
                        </div>

                        <div className="notif-content">
                          <div className="notif-title-row">
                            <div className="notif-title">
                              {isUnreadAlert(alert) && <span className="notif-unread-dot" />}
                              <span style={{ color: isUnreadAlert(alert) ? "var(--text)" : "var(--text-muted)" }}>
                                {alert.title || alert.type || "Update"}
                              </span>
                            </div>
                            <span className="notif-time">{timeAgo(alert.createdAt)}</span>
                          </div>
                          <div className="notif-desc">
                            {alert.message}
                          </div>
                        </div>
                        <span className="notif-item-go" aria-hidden="true">
                          <ChevronRight size={16} />
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}