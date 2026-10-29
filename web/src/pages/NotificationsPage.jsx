import { useState, useEffect, useMemo } from "react";
import { Bell, Info, AlertTriangle, PackageSearch, ReceiptText, ChevronDown } from "lucide-react";
import api from "../api.js";
import { getFriendlyError } from "../utils/errors.js";
import PageErrorBoundary from "../components/PageErrorBoundary.jsx";
import PageHeader from "../components/PageHeader.jsx";
import Badge from "../components/Badge.jsx";

// Ginawang context-aware ang pagkuha ng tema (bumabasa na rin ng message/title)
const getTheme = (alert) => {
  const type = (alert.type || "").toLowerCase();
  const msg = (alert.message || "").toLowerCase();
  const title = (alert.title || "").toLowerCase();

  // 1. Critical / Danger context
  if (type === "critical" || msg.includes("critical") || msg.includes("failed") || title.includes("urgent")) {
    return { icon: AlertTriangle, color: "var(--danger)", bg: "var(--danger-bg)" };
  }
  // 2. Sales / Orders context
  if (type === "sales" || msg.includes("order") || msg.includes("sale") || msg.includes("paid")) {
    return { icon: ReceiptText, color: "var(--success)", bg: "var(--success-bg)" };
  }
  // 3. Inventory / Restock context
  if (type === "restock" || type === "inventory" || msg.includes("stock") || msg.includes("inventory") || title.includes("restock")) {
    return { icon: PackageSearch, color: "var(--warn)", bg: "var(--warn-bg)" };
  }
  // 4. Default / Info
  return { icon: Info, color: "var(--info)", bg: "var(--info-bg)" };
};

export default function NotificationsPage() {
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("ALL");
  const [expandedId, setExpandedId] = useState(null); 

  useEffect(() => {
    fetchAlerts();
  }, []);

  async function fetchAlerts() {
    setLoading(true);
    try {
      const res = await api.get("/alerts?page=1&pageSize=100");
      setAlerts(res.data?.data || []);
      setError("");
    } catch (err) {
      setError(getFriendlyError(err, "Failed to load notifications."));
    } finally {
      setLoading(false);
    }
  }

  const filteredAlerts = useMemo(() => {
    if (filter === "ALL") return alerts;
    if (filter === "SALES") return alerts.filter(a => a.type === "sales" || (a.message && a.message.toLowerCase().includes("order")));
    if (filter === "RESTOCK") return alerts.filter(a => a.type === "restock" || a.type === "inventory");
    
    return alerts.filter(a => a.locationCode === filter || (a.message && a.message.includes(filter)));
  }, [alerts, filter]);

  const availableCarts = useMemo(() => {
    const carts = new Set();
    alerts.forEach(a => {
      if (a.locationCode) carts.add(a.locationCode);
    });
    return Array.from(carts).sort();
  }, [alerts]);

  const toggleExpand = (id) => {
    setExpandedId(expandedId === id ? null : id);
  };

  return (
    <PageErrorBoundary>
      <div className="page-container wide">
        <PageHeader
          eyebrow="Updates"
          title="Notifications"
          sub="View and filter all your system alerts and requests."
        />

        <div className="flex gap-2 flex-wrap mb-5">
          <button 
            className={`small-btn ${filter === "ALL" ? "" : "ghost"}`} 
            onClick={() => setFilter("ALL")}
          >
            All Updates
          </button>
          <button 
            className={`small-btn ${filter === "RESTOCK" ? "" : "ghost"}`} 
            onClick={() => setFilter("RESTOCK")}
          >
            Request Stock In
          </button>
          <button 
            className={`small-btn ${filter === "SALES" ? "" : "ghost"}`} 
            onClick={() => setFilter("SALES")}
          >
            Sales
          </button>
          
          {availableCarts.map(cartCode => (
            <button 
              key={cartCode}
              className={`small-btn ${filter === cartCode ? "" : "ghost"}`} 
              onClick={() => setFilter(cartCode)}
            >
              {cartCode}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {loading ? (
            <div className="muted text-center" style={{ padding: "40px" }}>Loading notifications...</div>
          ) : error ? (
            <div className="error-box">{error}</div>
          ) : filteredAlerts.length === 0 ? (
            
            <div style={{ 
              display: "flex", 
              flexDirection: "column", 
              alignItems: "center", 
              justifyContent: "center", 
              padding: "80px 20px",
              textAlign: "center"
            }}>
              <Bell size={48} className="muted" style={{ opacity: 0.5, marginBottom: "16px" }} />
              <strong style={{ fontSize: "16px", color: "var(--text)" }}>No notifications found</strong>
              <span className="muted" style={{ marginTop: "4px" }}>You don't have any notifications for "{filter}".</span>
            </div>

          ) : (
            <div className="flex flex-col gap-3">
              {filteredAlerts.map((alert) => {
                const theme = getTheme(alert); // Ipinasa ang buong alert object para masuri
                const Icon = theme.icon;
                const isExpanded = expandedId === alert.id;

                const alertNote = alert.notes || alert.note;

                return (
                  <div 
                    key={alert.id} 
                    onClick={() => toggleExpand(alert.id)}
                    style={{ 
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "stretch",
                      textAlign: "left",
                      padding: "24px",
                      background: "var(--surface)", // INO-MODIFIED: Laging puti (o surface color), hindi na nagiging gray
                      border: "1px solid var(--border)",
                      borderRadius: "24px",
                      boxShadow: isExpanded ? "0 8px 24px rgba(0, 0, 0, 0.06)" : "0 2px 12px rgba(0, 0, 0, 0.02)", // Lumalalim lang ang shadow kapag in-expand
                      cursor: "pointer",
                      transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)"
                    }}
                  >
                    {/* Header Row (Always Visible) */}
                    <div className="flex items-start justify-between gap-4">
                      
                      <div className="flex items-start gap-4" style={{ flex: 1, minWidth: 0 }}>
                        {/* Dynamic Indicator */}
                        <div style={{ 
                          width: "48px",
                          height: "48px",
                          borderRadius: "50%",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          flexShrink: 0,
                          color: theme.color, 
                          backgroundColor: theme.bg,
                          border: `1px solid color-mix(in srgb, ${theme.color} 30%, transparent)`,
                          transition: "all 0.3s ease"
                        }}>
                          <Icon size={22} />
                        </div>
                        
                        {/* Title & Preview Container */}
                        <div style={{ flex: 1, minWidth: 0, paddingTop: "2px" }}>
                          <div className="flex items-center gap-3 flex-wrap mb-1">
                            <span style={{ fontWeight: "800", color: "var(--text)", fontSize: "16px" }}>
                              {alert.title || alert.type?.toUpperCase() || "UPDATE"}
                            </span>
                            {alert.status === "unread" && (
                              <Badge variant="warn">Unread</Badge>
                            )}
                            {alert.locationCode && (
                              <Badge variant="neutral">{alert.locationCode}</Badge>
                            )}
                          </div>
                          
                          {/* Smooth Collapsing Preview */}
                          <div style={{
                            display: "grid",
                            gridTemplateRows: isExpanded ? "0fr" : "1fr",
                            transition: "grid-template-rows 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
                          }}>
                            <div style={{ overflow: "hidden" }}>
                              <p className="muted small truncate" style={{ 
                                margin: 0, 
                                fontSize: "14px",
                                opacity: isExpanded ? 0 : 1,
                                transition: "opacity 0.2s ease"
                              }}>
                                {alert.message}
                                {alertNote && <span style={{ fontStyle: "italic", marginLeft: "4px" }}>— Note: {alertNote}</span>}
                              </p>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Right Side Info (Time & Animated Chevron) */}
                      <div className="flex flex-col items-end justify-between gap-3" style={{ flexShrink: 0, height: "100%", paddingTop: "2px" }}>
                        <span className="muted small">
                          {new Date(alert.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
                        </span>
                        <ChevronDown 
                          size={20} 
                          className="muted" 
                          style={{ 
                            transform: isExpanded ? "rotate(180deg)" : "rotate(0deg)",
                            transition: "transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)"
                          }} 
                        />
                      </div>
                      
                    </div>

                    {/* Smoothly Expanding Full Details */}
                    <div style={{ 
                      display: "grid",
                      gridTemplateRows: isExpanded ? "1fr" : "0fr",
                      transition: "grid-template-rows 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
                    }}>
                      <div style={{ overflow: "hidden" }}>
                        <div style={{
                          marginTop: "16px",
                          paddingTop: "16px",
                          paddingLeft: "64px", 
                          borderTop: "1px dashed var(--border)",
                          opacity: isExpanded ? 1 : 0,
                          transform: isExpanded ? "translateY(0)" : "translateY(-10px)",
                          transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
                        }}>
                          <p style={{ margin: 0, color: "var(--text)", lineHeight: "1.6", fontSize: "14px", whiteSpace: "pre-wrap" }}>
                            {alert.message}
                          </p>

                          {/* Premium Staff Note Section */}
                          {alertNote && (
                            <div style={{ 
                              marginTop: "16px", 
                              padding: "14px 18px", 
                              backgroundColor: theme.bg, 
                              border: `1px solid color-mix(in srgb, ${theme.color} 25%, transparent)`,
                              borderRadius: "14px"
                            }}>
                              <span style={{ 
                                display: "block", 
                                fontSize: "11px", 
                                fontWeight: "800", 
                                color: theme.color, 
                                marginBottom: "6px", 
                                textTransform: "uppercase", 
                                letterSpacing: "0.08em" 
                              }}>
                                Staff Note
                              </span>
                              <p style={{ 
                                margin: 0, 
                                color: "var(--text)", 
                                fontSize: "14px", 
                                fontStyle: "italic",
                                lineHeight: "1.5"
                              }}>
                                {alertNote}
                              </p>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </PageErrorBoundary>
  );
}