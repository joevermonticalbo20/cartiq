import { useState, useRef, useEffect } from "react";
import { Bell, Check, PackageSearch, ReceiptText, AlertTriangle, Info } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import api from "../api.js";
import { useLiveEvent } from "../hooks/useLiveStream.js";

// Helper para sa "1h ago", "2m ago" format
function timeAgo(dateString) {
  const date = new Date(dateString);
  const diffMins = Math.floor((new Date() - date) / 60000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  return `${Math.floor(diffHrs / 24)}d ago`;
}

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [alerts, setAlerts] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [activeTab, setActiveTab] = useState("All");
  const ref = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    fetchAlerts();
  }, []);

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

  async function fetchAlerts() {
    try {
      const res = await api.get("/alerts?page=1&pageSize=30");
      const data = res.data?.data || [];
      setAlerts(data);
      setUnreadCount(data.filter(a => a.status === "unread").length);
    } catch {
      // Background fetch, ignore errors
    }
  }

  useLiveEvent("alert:new", (newAlert) => {
    setAlerts(prev => [newAlert, ...prev].slice(0, 30));
    setUnreadCount(prev => prev + 1);
  });

  async function markAllAsRead() {
    try {
      await api.patch("/alerts/read-all");
      setAlerts(alerts.map(a => ({ ...a, status: "read" })));
      setUnreadCount(0);
    } catch {
      // Background action
    }
  }

  // INO-MODIFIED: Dynamic indicator theme (Icon, Color, Background)
  const getTheme = (type) => {
    if (type === "restock" || type === "inventory") {
      return { icon: PackageSearch, color: "var(--warn)", bg: "var(--warn-bg)" };
    }
    if (type === "sales") {
      return { icon: ReceiptText, color: "var(--success)", bg: "var(--success-bg)" };
    }
    if (type === "critical") {
      return { icon: AlertTriangle, color: "var(--danger)", bg: "var(--danger-bg)" };
    }
    return { icon: Info, color: "var(--info)", bg: "var(--info-bg)" };
  };

  const displayAlerts = alerts.filter(a => {
    if (activeTab === "Unread") return a.status === "unread";
    if (activeTab === "Sales") return a.type === "sales" || (a.message && a.message.toLowerCase().includes("order"));
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
        {unreadCount > 0 && <span className="notif-badge">{unreadCount}</span>}
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
              <p className="notif-empty">No {activeTab.toLowerCase()} notifications</p>
            ) : (
              <ul className="notif-list">
                {displayAlerts.map((alert) => {
                  const theme = getTheme(alert.type);
                  const Icon = theme.icon;

                  return (
                    <li key={alert.id} className="notif-item">
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
                            {alert.status === "unread" && <span className="notif-unread-dot" />}
                            <span style={{ color: alert.status === "read" ? "var(--text-muted)" : "var(--text)"}}>
                              {alert.title || alert.type?.replace(/^\w/, c => c.toUpperCase()) || "Update"}
                            </span>
                          </div>
                          <span className="notif-time">{timeAgo(alert.createdAt)}</span>
                        </div>
                        <div className="notif-desc">
                          {alert.message}
                        </div>
                      </div>
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