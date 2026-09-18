import { useEffect, useState, useCallback } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  BarChart2,
  Boxes,
  CheckCircle,
  Clock,
  DollarSign,
  Info,
  Minus,
  Radio,
  ReceiptText,
  RefreshCw,
  ShoppingBag,
  TrendingUp,
  Users,
  X,
} from "lucide-react";

import api, { API_BASE } from "../api.js";
import { getFriendlyError } from "../utils/errors.js";
import Badge from "../components/Badge.jsx";
import EmptyState from "../components/EmptyState.jsx";
import ErrorBox from "../components/ErrorBox.jsx";
import Skeleton from "../components/Skeleton.jsx";
import SensorPanel from "../components/SensorPanel.jsx";
import Select from "../components/Select.jsx";
import { useToast } from "../components/Toast.jsx";
import { useSSE } from "../hooks/useSSE.js";

function statusClass(s) {
  if (s === "critical") return "critical";
  if (s === "low") return "low";
  return "ok";
}

function formatTime(d) {
  return new Date(d).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function initials(name) {
  if (!name) return "?";
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

function TrendArrow({ dir }) {
  if (dir === "up") return <ArrowUp size={12} />;
  if (dir === "down") return <ArrowDown size={12} />;
  return <Minus size={12} />;
}

function getLocalToday() {
  const tzOffset = new Date().getTimezoneOffset() * 60000;
  return new Date(Date.now() - tzOffset).toISOString().slice(0, 10);
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useOutletContext();
  const firstName = user?.name ? user.name.split(" ")[0] : "there";

  const [report, setReport] = useState(null);
  const [inventory, setInventory] = useState([]);
  const [onShift, setOnShift] = useState([]);
  const [latestSales, setLatestSales] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [trends, setTrends] = useState(null);
  const [prev, setPrev] = useState(null);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [sectionErrors, setSectionErrors] = useState({});

  const [locations, setLocations] = useState([]);
  const [dateFilter, setDateFilter] = useState("");
  const [cartFilter, setCartFilter] = useState("");

  const sectionLabels = {
    report: "Sales",
    inventory: "Inventory",
    staff: "Staff",
    sales: "Orders",
    alerts: "Alerts",
    trends: "Trends",
  };

  const [sseStatus, setSseStatus] = useState("connecting");
  const [livePulse, setLivePulse] = useState(0);

  useEffect(() => {
    api.get("/catalog").then(({ data }) => setLocations(data.locations)).catch(() => {});
  }, []);

  const getStreamTicket = useCallback(async () => {
    try {
      const { data } = await api.post("/events/ticket", {});
      return data?.ticket ?? null;
    } catch {
      return null;
    }
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    const errs = {};

    const settle = async (key, promise, apply) => {
      try {
        apply(await promise);
      } catch (err) {
        errs[key] = getFriendlyError(err, "Couldn't load this section.");
      }
    };

    const dQ = dateFilter ? `date=${dateFilter}` : "";
    const lQ = cartFilter ? `location_code=${cartFilter}` : "";
    const cQ = cartFilter ? `code=${cartFilter}` : "";

    const buildQ = (base, params) => {
      const query = params.filter(Boolean).join("&");
      if (!query) return base;
      return base.includes("?") ? `${base}&${query}` : `${base}?${query}`;
    };

    // Param names must match each backend contract: reports/trends take
    // `code`, orders take `location_code`, alerts have no cart filter
    // (sending location_code there was silently ignored).
    await Promise.all([
      settle("report", api.get(buildQ("/reports/daily", [dQ, cQ])), (r) => setReport(r.data)),
      settle("inventory", api.get("/inventory"), (r) => setInventory(r.data?.locations ?? [])),
      settle("staff", api.get("/staff/on-shift"), (r) => setOnShift(r.data?.on_shift ?? [])),
      settle("sales", api.get(buildQ("/orders?page=1&pageSize=5", [dQ, lQ])), (r) => setLatestSales(r.data?.data ?? [])),
      settle("alerts", api.get("/alerts?unread_only=true&page=1&pageSize=5"), (r) => setAlerts(r.data?.data ?? [])),
      settle("trends", api.get(buildQ("/analytics/trends?days=7", [cQ])).catch(() => ({ data: null })), (r) => setTrends(r.data)),
      settle("prev", api.get(buildQ("/reports/daily?daysAgo=1", [dQ, cQ])).catch(() => ({ data: null })), (r) => setPrev(r.data)),
    ]);

    setSectionErrors(errs);
    if (Object.keys(errs).length < 7) setLastUpdated(new Date());

    setLoading(false);
    setRefreshing(false);
  }, [dateFilter, cartFilter]);

  useEffect(() => {
    const timer = setTimeout(refresh, 0);
    const t = setInterval(refresh, 60000);
    return () => { clearTimeout(timer); clearInterval(t); };
  }, [refresh]);

  useSSE(`${API_BASE}/events`, {
    getTicket: getStreamTicket,
    onStatus: setSseStatus,
    onEvent: (event, data) => {
      const isViewingLive = !dateFilter || dateFilter === getLocalToday();
      if (!isViewingLive) return;

      if (event === "order:new") {
        if (cartFilter && data.locationCode && data.locationCode !== cartFilter) return;

        setReport((r) =>
          r
            ? {
                ...r,
                total_sales: (r.total_sales ?? 0) + (data.total ?? 0),
                orders: (r.orders ?? 0) + 1,
              }
            : r
        );
        setLivePulse((n) => n + 1);
        toast(`New order: P${(data.total ?? 0).toFixed(0)} @ ${data.locationCode ?? " "}`, "success");
      } else if (event === "alert:new") {
        if (cartFilter && data.locationCode && data.locationCode !== cartFilter) return;

        setAlerts((a) => [
          { id: data.id, type: data.type, message: data.message },
          ...(Array.isArray(a) ? a : []),
        ].slice(0, 5));
        toast(`Alert: ${data.message}`, "warn");
      }
    },
  });

  const safeInventory = Array.isArray(inventory) ? inventory : [];
  const safeOnShift = Array.isArray(onShift) ? onShift : [];
  const safeLatestSales = Array.isArray(latestSales) ? latestSales : [];
  const safeAlerts = Array.isArray(alerts) ? alerts : [];

  const activeInventory = cartFilter ? safeInventory.filter((l) => l.code === cartFilter) : safeInventory;
  const activeOnShift = cartFilter ? safeOnShift.filter((s) => s.location_code === cartFilter) : safeOnShift;

  const lowCount = activeInventory.reduce((sum, loc) => sum + (loc.items ?? []).filter((i) => i.status !== "ok").length, 0);
  const criticalCount = activeInventory.reduce((sum, loc) => sum + (loc.items ?? []).filter((i) => i.status === "critical").length, 0);
  const lowStockAlerts = safeAlerts.filter((a) => a.type === "LOW_STOCK");

  const todaySales = report?.total_sales ?? 0;
  const todayOrders = report?.orders ?? 0;
  const avgTicket = todayOrders > 0 ? todaySales / todayOrders : 0;
  
  const topItem = (() => {
    const all = trends?.top_items ?? [];
    if (all.length === 0) return null;
    return all.sort((a, b) => (b.qty ?? 0) - (a.qty ?? 0))[0];
  })();

  const pct = (today, was) => was != null && was > 0 ? ((today - was) / was) * 100 : null;
  const dirOf = (d) => (d == null ? "flat" : d > 0 ? "up" : d < 0 ? "down" : "flat");
  const labelOf = (d) => d == null ? "No prior data" : `${d >= 0 ? "+" : ""}${d.toFixed(1)}% vs prior`;

  const salesDelta = pct(todaySales, prev?.total_sales);
  const ordersDelta = pct(todayOrders, prev?.orders);
  const salesDir = dirOf(salesDelta);
  const ordersDir = dirOf(ordersDelta);
  
  const weeklyMax = trends?.by_weekday ? Math.max(...trends.by_weekday.map((s) => s.total_sales), 1) : 1;

  const locationOptions = [
    { value: "", label: "All carts" },
    ...locations.map((l) => ({ value: l.code, label: l.code }))
  ];

  return (
    <div className="page-container wide">
      {/* =========================================================
          INLINE CSS: STRETCH EMPTY STATES FOR DASHBOARD PANELS
      ========================================================= */}
      <style>{`
        /* Stretches the gray dashed box to fill the panel naturally */
        .dashboard-body .panel .empty-state-card,
        .dashboard-trend-panel .empty-state-card {
          flex: 1;
          justify-content: center;
          width: 100%;
        }
      `}</style>

      <div className="page-header">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="page-header-title">Hello, {firstName}</h1>
            <span
              className={`sse-pill ${sseStatus === "open" ? "open" : sseStatus === "down" ? "down" : "connecting"}`}
              title={`Live stream: ${sseStatus}`}
              aria-label={`Connection status: ${sseStatus}`}
            >
              <Radio
                size={11}
                className={sseStatus === "open" ? "spin" : ""}
                style={sseStatus === "open" ? { animation: "pulse-dot 1.6s ease-in-out infinite" } : undefined}
              />
              {sseStatus === "open" ? "Live" : sseStatus === "down" ? "Offline" : "Connecting"}
            </span>
            {livePulse > 0 && (
              <span className="live-badge" aria-label={`${livePulse} live updates`}>
                {livePulse}
              </span>
            )}
          </div>
          <p className="page-header-subtitle">
            {loading ? "Loading latest data..." : "Stay on top of your operations, monitor progress, and track real-time status."}
          </p>
        </div>
        
        {/* GLOBAL HEADER FILTERS */}
        <div className="page-header-actions" style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <Select value={cartFilter} onChange={setCartFilter} options={locationOptions} placeholder="All carts" />
          <input
            type="date"
            value={dateFilter}
            onChange={e => setDateFilter(e.target.value)}
            style={{ height: '36px', borderRadius: '14px', border: '1px solid var(--border)', padding: '0 12px', background: 'var(--surface-alt)', color: 'var(--text)' }}
          />
          {(dateFilter || cartFilter) && (
             <button className="danger-ghost small-btn" onClick={() => { setDateFilter(""); setCartFilter(""); }}>
                <X size={14} /> Clear
             </button>
          )}
          <span className="muted small" style={{ marginLeft: "4px" }}>
            Last updated {lastUpdated?.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) ?? "just now"}
          </span>
          <button className="ghost small-btn" onClick={refresh} disabled={refreshing}>
            <RefreshCw size={14} className={refreshing ? "spin" : ""} /> Refresh
          </button>
        </div>
      </div>

      {Object.keys(sectionErrors).length > 0 && !loading && (
        <ErrorBox
          message={<>Couldn&apos;t refresh: {Object.keys(sectionErrors).map((k) => sectionLabels[k] ?? k).join(", ")}. Showing available data.</>}
          onRetry={refresh}
          style={{ marginBottom: "var(--space-4)" }}
        />
      )}

      {loading ? (
        <>
          <div className="dashboard-top-row">
            <div className="dashboard-kpi-stack">
              <div className="kpi-card large"><Skeleton rows={3} height={20} /></div>
              <div className="kpi-card large"><Skeleton rows={3} height={20} /></div>
            </div>
            <div className="dashboard-kpi-grid-2x2">
              <div className="kpi-card"><Skeleton rows={2} /></div>
              <div className="kpi-card"><Skeleton rows={2} /></div>
              <div className="kpi-card"><Skeleton rows={2} /></div>
              <div className="kpi-card"><Skeleton rows={2} /></div>
            </div>
            <div className="panel dashboard-trend-panel">
              <Skeleton rows={2} />
              <div className="skel" style={{ flex: 1, minHeight: "140px", marginTop: "16px", borderRadius: "8px" }} />
            </div>
          </div>
        </>
      ) : (
        <div className="dashboard-top-row">
          {/* COLUMN 1: Large KPIs */}
          <div className="dashboard-kpi-stack">
            <div className="kpi-card large solid-brand" onClick={() => navigate("/sales")} role="button" tabIndex={0}>
              <div className="kpi-card-header">
                <span className="kpi-card-label">{dateFilter ? "Sales (Filtered)" : "Sales today"}</span>
                <span className="kpi-card-icon"><DollarSign size={22} /></span>
              </div>
              <div className="kpi-card-body">
                <div>
                  <div className="kpi-card-value">{report ? <>P{Number(todaySales).toLocaleString()}</> : "—"}</div>
                  <div className="kpi-card-sub">{report ? `${todayOrders} orders - avg P${avgTicket.toFixed(0)} ticket` : "Sales unavailable"}</div>
                </div>
                <span className="kpi-card-trend"><TrendArrow dir={salesDir} /> {labelOf(salesDelta)}</span>
              </div>
            </div>

            <div className="kpi-card large" onClick={() => navigate("/sales")} role="button" tabIndex={0}>
              <div className="kpi-card-header">
                <span className="kpi-card-label">{dateFilter ? "Orders (Filtered)" : "Orders today"}</span>
                <span className="kpi-card-icon"><ShoppingBag size={22} /></span>
              </div>
              <div className="kpi-card-body">
                <div>
                  <div className="kpi-card-value">{report ? todayOrders : "—"}</div>
                  <div className="kpi-card-sub">Across {activeInventory.length} active carts</div>
                </div>
                <span className={`kpi-card-trend ${ordersDir}`}><TrendArrow dir={ordersDir} /> {labelOf(ordersDelta)}</span>
              </div>
            </div>
          </div>

          {/* COLUMN 2: Secondary KPIs */}
          <div className="dashboard-kpi-grid-2x2">
            <div className="kpi-card" onClick={() => navigate("/sales")} role="button" tabIndex={0}>
              <div className="kpi-card-header">
                <span className="kpi-card-label">Avg ticket</span>
                <span className="kpi-card-icon"><ReceiptText size={20} /></span>
              </div>
              <div className="kpi-card-value">P{avgTicket.toFixed(0)}</div>
              <div className="kpi-card-sub">Per order {dateFilter ? "selected" : "today"}</div>
            </div>

            <div className="kpi-card" onClick={() => navigate("/analytics")} role="button" tabIndex={0}>
              <div className="kpi-card-header">
                <span className="kpi-card-label">Top item</span>
                <span className="kpi-card-icon"><BarChart2 size={20} /></span>
              </div>
              <div className="kpi-card-value" style={{ fontSize: "var(--fs-lg)", fontWeight: "var(--fw-extrabold)" }}>
                {topItem ? (topItem.flavor ?? topItem.name) : "-"}
              </div>
              <div className="kpi-card-sub">{topItem ? `${topItem.qty ?? 0} sold (7d)` : "No data yet"}</div>
            </div>

            <div className="kpi-card" onClick={() => navigate("/inventory")} role="button" tabIndex={0}>
              <div className="kpi-card-header">
                <span className="kpi-card-label">Low stock</span>
                <span className="kpi-card-icon" style={lowCount > 0 ? { background: "var(--danger-bg)", color: "var(--danger)" } : undefined}>
                  <AlertTriangle size={20} />
                </span>
              </div>
              <div className="kpi-card-value" style={lowCount > 0 ? { color: "var(--danger)" } : undefined}>{lowCount}</div>
              <div className="kpi-card-sub">{criticalCount} critical - {lowStockAlerts.length} alerts</div>
            </div>

            <div className="kpi-card" onClick={() => navigate("/staff")} role="button" tabIndex={0}>
              <div className="kpi-card-header">
                <span className="kpi-card-label">On shift</span>
                <span className="kpi-card-icon"><Users size={20} /></span>
              </div>
              <div className="kpi-card-value">{activeOnShift.length}</div>
              <div className="kpi-card-sub">
                {activeOnShift.length > 0 ? activeOnShift.map((s) => s.location_code).join(", ") : "No staff tapped in"}
              </div>
            </div>
          </div>

          {/* COLUMN 3: Chart Widget */}
          {trends && trends.by_weekday ? (
            <section className="panel dashboard-trend-panel" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
              <div className="panel-head">
                <h3 className="section-title flex items-center gap-2" style={{ borderBottom: "none", margin: 0, padding: 0 }}>
                  Weekly sales trend
                </h3>
                <Badge variant="brand">P{Number(trends.total_sales).toLocaleString()}</Badge>
              </div>
              <div className="trend-bars mt-2">
                {trends.by_weekday.map((d) => {
                  const pct = (d.total_sales / weeklyMax) * 100;
                  return (
                    <div key={d.dow} className="trend-bar-col" title={`P${Number(d.total_sales).toLocaleString()} - ${d.orders ?? 0} orders`}>
                      <div className="trend-bar" style={{ height: `${Math.max(pct, 2)}%` }} />
                      <span className="muted small">{d.label}</span>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : (
            <div className="panel dashboard-trend-panel" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
              <EmptyState icon={TrendingUp} title="No trend data" compact />
            </div>
          )}
        </div>
      )}

      {/* BOTTOM SECTION */}
      {!loading && (
        <div className="dashboard-body" style={{ alignItems: "stretch" }}>
          
          {/* ======================================================== */}
          {/* ROW 1: Orders (Span 2) + Live Sensor (Span 1) */}
          {/* ======================================================== */}
          
          {/* 1. Recent Orders (Span 2) */}
          <section className="panel widget-orders" aria-live="polite" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
            <div className="panel-head" style={{ marginBottom: "16px" }}>
              <h3 className="section-title flex items-center gap-2" style={{ borderBottom: "none", padding: 0, margin: 0 }}>
                Recent orders
              </h3>
              <button className="ghost small-btn" onClick={() => navigate("/sales")}>
                View all
              </button>
            </div>
            {safeLatestSales.length === 0 ? (
              <EmptyState icon={ShoppingBag} title="No sales found" subtitle="Sales appear here as soon as staff records them." compact />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Items</th>
                        <th className="t-right">Total</th>
                        <th>Payment</th>
                        <th>Location</th>
                      </tr>
                    </thead>
                    <tbody>
                      {safeLatestSales.map((o) => (
                        <tr key={o.id}>
                          <td className="text-xs muted">{formatTime(o.createdAt)}</td>
                          <td className="text-xs">{(o.items ?? []).map((i) => `${i.qty}x ${i.productName}${i.flavor ? ` (${i.flavor})` : ""}`).join(", ")}</td>
                          <td className="t-right"><strong>P{Number(o.total).toLocaleString()}</strong></td>
                          <td><Badge variant="neutral">{(o.paymentMethod || "CASH").toUpperCase()}</Badge></td>
                          <td><Badge variant="info">{o.location?.code}</Badge></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="text-center muted text-sm mt-4" style={{ marginTop: "auto", paddingTop: "16px" }}>
                  Showing the 5 most recent orders. Click the &quot;View all&quot; button to see complete information.
                </div>
              </div>
            )}
          </section>

          {/* 2. Live Sensor (Span 1, matching the exact height of the row) */}
          <div style={{ height: "100%" }}>
            <SensorPanel code={cartFilter || "CART-01"} />
          </div>


          {/* ======================================================== */}
          {/* ROW 2: Alerts (Span 1) + Cart Status (Span 1) + Staff (Span 1) */}
          {/* ======================================================== */}

          {/* 3. Stock Alerts */}
          <section className="panel" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
            <div className="panel-head" style={{ marginBottom: "12px" }}>
              <h3 className="section-title flex items-center gap-2" style={{ borderBottom: "none", padding: 0, margin: 0 }}>
                Stock alerts
              </h3>
              <div className="flex items-center gap-2">
                <button className="ghost small-btn" onClick={() => navigate("/inventory")}>View inventory</button>
              </div>
            </div>
            
            {activeInventory.length === 0 ? (
              <EmptyState icon={Boxes} title="No carts configured" subtitle="Stock alerts appear as soon as a cart reports readings." compact />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
                {activeInventory.every((loc) => (loc.items ?? []).every((i) => i.status === "ok")) ? (
                  <EmptyState icon={CheckCircle} title="All stock healthy" subtitle="Nothing below threshold right now." compact />
                ) : (
                  <>
                    {activeInventory
                      .flatMap((loc) => (loc.items ?? []).filter((i) => i.status !== "ok").map((i) => ({ ...i, locationCode: loc.code })))
                      .slice(0, 5) // MAXIMUM 5 ITEMS
                      .map((it) => {
                        const Icon = it.status === "critical" ? AlertTriangle : Info;
                        return (
                          <div className="alert-item" key={`${it.id}`}>
                            <span className="alert-item-icon">
                              <Icon size={16} style={{ color: it.status === "critical" ? "var(--danger)" : "var(--warn)" }} />
                            </span>
                            <span className="alert-item-text">
                              <div className="alert-item-name">{it.name} <span className="text-xs muted">@ {it.locationCode}</span></div>
                              <div className="alert-item-detail">{it.stock} {it.unit} remaining - threshold {it.threshold}</div>
                            </span>
                            <Badge variant={statusClass(it.status)}>{it.status.toUpperCase()}</Badge>
                          </div>
                        );
                      })}
                    <div className="text-center muted text-sm mt-4" style={{ marginTop: "auto", paddingTop: "16px" }}>
                      Showing up to 5 alerts. Check the Inventory page to manage all stocks.
                    </div>
                  </>
                )}
              </div>
            )}
          </section>

          {/* 4. Cart Status */}
          <section className="panel" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
            <div className="panel-head" style={{ marginBottom: "12px" }}>
              <h3 className="section-title flex items-center gap-2" style={{ borderBottom: "none", padding: 0, margin: 0 }}>
                Cart status
              </h3>
              <Badge variant="neutral">{activeInventory.length} carts</Badge>
            </div>
            <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
              {activeInventory.length === 0 ? (
                 <EmptyState icon={Boxes} title="No carts configured" subtitle="Carts will appear here once added." compact />
              ) : (
                <>
                  {activeInventory.slice(0, 5).map((loc) => { // MAXIMUM 5 ITEMS
                    const locItems = loc.items ?? [];
                    const low = locItems.filter((i) => i.status !== "ok").length;
                    const critical = locItems.filter((i) => i.status === "critical").length;
                    const dotClass = critical > 0 ? "critical" : low > 0 ? "warn" : "ok";

                    return (
                      <div key={loc.id} className="cart-status-item" onClick={() => navigate("/inventory")} role="button" tabIndex={0}>
                        <span className={`status-dot ${dotClass}`} />
                        <span className="alert-item-text">
                          <div className="alert-item-name">{loc.code}</div>
                          <div className="alert-item-detail">{loc.name} - {locItems.length} items</div>
                        </span>
                        <Badge variant={critical > 0 ? "danger" : low > 0 ? "warn" : "ok"}>
                          {critical > 0 ? `${critical} critical` : low > 0 ? `${low} low` : "OK"}
                        </Badge>
                      </div>
                    );
                  })}
                  <div className="text-center muted text-sm mt-4" style={{ marginTop: "auto", paddingTop: "16px" }}>
                    Showing up to 5 carts. Click on a cart to see complete inventory information.
                  </div>
                </>
              )}
            </div>
          </section>

          {/* 5. On-shift Staff */}
          <section className="panel" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
            <div className="panel-head" style={{ marginBottom: "12px" }}>
              <h3 className="section-title flex items-center gap-2" style={{ borderBottom: "none", padding: 0, margin: 0 }}>
                On-shift staff
              </h3>
              <Badge variant={activeOnShift.length > 0 ? "ok" : "neutral"}>{activeOnShift.length} on duty</Badge>
            </div>
            
            {activeOnShift.length === 0 ? (
              <EmptyState icon={Clock} title="No one on shift" subtitle="Staff will appear here when they tap in." compact />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
                <div className="flex flex-col gap-2">
                  {activeOnShift.slice(0, 5).map((s) => ( // MAXIMUM 5 ITEMS
                    <div key={`${s.name}-${s.location_code}`} className="cart-status-item" style={{ borderBottom: "none" }}>
                      <span className="staff-avatar">{initials(s.name)}</span>
                      <span className="alert-item-text">
                        <div className="alert-item-name">{s.name}</div>
                        <div className="alert-item-detail">{s.location_name} - since {formatTime(s.since)}</div>
                      </span>
                      <Badge variant={s.registered ? "ok" : "danger"}>{s.registered ? "ON" : "UNREG"}</Badge>
                    </div>
                  ))}
                </div>
                <div className="text-center muted text-sm mt-4" style={{ marginTop: "auto", paddingTop: "16px" }}>
                  Showing up to 5 recent shifts. Go to the Staff page for complete information.
                </div>
              </div>
            )}
          </section>

        </div>
      )}
    </div>
  );
}