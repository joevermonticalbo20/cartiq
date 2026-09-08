import { useEffect, useState, useCallback } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  BarChart2,
  Bell,
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
} from "lucide-react";
import api, { API_BASE } from "../api.js";
import Badge from "../components/Badge.jsx";
import EmptyState from "../components/EmptyState.jsx";
import Skeleton from "../components/Skeleton.jsx";
import SensorPanel from "../components/SensorPanel.jsx";
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

// Keyboard parity for clickable cards: Enter/Space activates like a click.
function activate(e, fn) {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fn();
  }
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const toast = useToast();
  // Kukunin natin ang user context para makuha ang pangalan
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

  const [sseStatus, setSseStatus] = useState("connecting");
  const [livePulse, setLivePulse] = useState(0);
  const token = localStorage.getItem("cartiq_token") || null;

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [rpt, inv, staff, sales, alr, trend, yday] = await Promise.all([
        api.get("/reports/daily"),
        api.get("/inventory"),
        api.get("/staff/on-shift"),
        api.get("/orders?page=1&pageSize=8"),
        api.get("/alerts?unread_only=true&page=1&pageSize=6"),
        api.get("/analytics/trends?days=7").catch(() => ({ data: null })),
        api.get("/reports/daily?daysAgo=1").catch(() => ({ data: null })),
      ]);

      setReport(rpt.data);
      setInventory(inv.data.locations);
      setOnShift(staff.data.on_shift);
      setLatestSales(sales.data.data);
      setAlerts(alr.data.data);
      setTrends(trend.data);
      setPrev(yday.data);
      setLastUpdated(new Date());
    } catch {
      toast("Failed to refresh dashboard data", "error");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [toast]);

  useEffect(() => {
    const timer = setTimeout(refresh, 0);
    const t = setInterval(refresh, 60000);
    return () => { clearTimeout(timer); clearInterval(t); };
  }, [refresh]);

  useSSE(`${API_BASE}/events`, {
    token,
    onStatus: setSseStatus,
    onEvent: (event, data) => {
      if (event === "order:new") {
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
        toast(
          `New order: P${(data.total ?? 0).toFixed(0)} @ ${data.locationCode ?? " "}`,
          "success"
        );
      } else if (event === "alert:new") {
        setAlerts((a) => [
          { id: data.id, type: data.type, message: data.message },
          ...a,
        ].slice(0, 6));
        toast(`Alert: ${data.message}`, "warn");
      }
    },
  });

  const lowCount = inventory.reduce(
    (sum, loc) => sum + loc.items.filter((i) => i.status !== "ok").length,
    0
  );
  const criticalCount = inventory.reduce(
    (sum, loc) => sum + loc.items.filter((i) => i.status === "critical").length,
    0
  );

  const lowStockAlerts = alerts.filter((a) => a.type === "LOW_STOCK");

  const todaySales = report?.total_sales ?? 0;
  const todayOrders = report?.orders ?? 0;
  const avgTicket = todayOrders > 0 ? todaySales / todayOrders : 0;

  const topItem = (() => {
    if (!trends?.by_weekday) return null;
    const all = trends.by_weekday.flatMap((d) => d.top_items ?? []);
    if (all.length === 0) return null;
    return all.sort((a, b) => (b.qty ?? 0) - (a.qty ?? 0))[0];
  })();

  const pct = (today, was) =>
    was != null && was > 0 ? ((today - was) / was) * 100 : null;

  const dirOf = (d) => (d == null ? "flat" : d > 0 ? "up" : d < 0 ? "down" : "flat");
  
  // INO-MODIFIED: Pinalitan ang "Idle" ng "No prior data"
  const labelOf = (d) =>
    d == null ? "No prior data" : `${d >= 0 ? "+" : ""}${d.toFixed(1)}% vs yesterday`;

  const salesDelta = pct(todaySales, prev?.total_sales);
  const ordersDelta = pct(todayOrders, prev?.orders);

  const salesDir = dirOf(salesDelta);
  const ordersDir = dirOf(ordersDelta);

  const weeklyMax = trends?.by_weekday
    ? Math.max(...trends.by_weekday.map((s) => s.total_sales), 1)
    : 1;

  return (
    <div className="page-container wide">
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
                style={
                  sseStatus === "open"
                    ? { animation: "pulse-dot 1.6s ease-in-out infinite" }
                    : undefined
                }
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
            {loading
              ? "Loading latest data..."
              : "Stay on top of your operations, monitor progress, and track real-time status."}
          </p>
        </div>
        <div className="page-header-actions">
          <span className="muted small" style={{ marginRight: "4px" }}>
            Last updated {lastUpdated?.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) ?? "just now"}
          </span>
          <button
            className="ghost small-btn"
            onClick={refresh}
            disabled={refreshing}
            aria-label="Refresh dashboard"
            title="Refresh now"
          >
            <RefreshCw size={14} className={refreshing ? "spin" : ""} />
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

      {loading ? (
        <>
          {/* Custom Skeleton para sa Top Row */}
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
          
          {/* Custom Skeleton para sa Bottom Row */}
          <div className="dashboard-body">
            <div className="panel widget-orders"><Skeleton rows={6} /></div>
            <div className="panel"><Skeleton rows={4} /></div>
            <div className="panel"><Skeleton rows={4} /></div>
            <div className="panel"><Skeleton rows={4} /></div>
            <div className="panel"><Skeleton rows={4} /></div>
          </div>
        </>
      ) : (
        <div className="dashboard-top-row">
          
          {/* COLUMN 1: Large KPIs (Stacked) */}
          <div className="dashboard-kpi-stack">
            {/* Sales Card - Styled as solid brand color */}
            <div
              className="kpi-card large solid-brand"
              onClick={() => navigate("/sales")}
              onKeyDown={(e) => activate(e, () => navigate("/sales"))}
              role="button"
              tabIndex={0}
              aria-label="Sales today - view sales"
            >
              <div className="kpi-card-header">
                <span className="kpi-card-label">Sales today</span>
                <span className="kpi-card-icon">
                  <DollarSign size={22} />
                </span>
              </div>
              <div className="kpi-card-body">
                <div>
                  <div className="kpi-card-value">
                    P{Number(todaySales).toLocaleString()}
                  </div>
                  <div className="kpi-card-sub">
                    {todayOrders} order{todayOrders !== 1 ? "s" : ""} - avg P
                    {avgTicket.toFixed(0)} ticket
                  </div>
                </div>
                <span className="kpi-card-trend">
                  <TrendArrow dir={salesDir} />
                  {labelOf(salesDelta)}
                </span>
              </div>
            </div>

            {/* Orders Card */}
            <div
              className="kpi-card large"
              onClick={() => navigate("/sales")}
              onKeyDown={(e) => activate(e, () => navigate("/sales"))}
              role="button"
              tabIndex={0}
              aria-label="Orders today - view sales"
            >
              <div className="kpi-card-header">
                <span className="kpi-card-label">Orders today</span>
                <span className="kpi-card-icon">
                  <ShoppingBag size={22} />
                </span>
              </div>
              <div className="kpi-card-body">
                <div>
                  <div className="kpi-card-value">{todayOrders}</div>
                  <div className="kpi-card-sub">
                    Across {inventory.length} active cart
                    {inventory.length !== 1 ? "s" : ""}
                  </div>
                </div>
                <span className={`kpi-card-trend ${ordersDir}`}>
                  <TrendArrow dir={ordersDir} />
                  {labelOf(ordersDelta)}
                </span>
              </div>
            </div>
          </div>

          {/* COLUMN 2: Secondary KPIs (2x2 Grid) */}
          <div className="dashboard-kpi-grid-2x2">
            <div
              className="kpi-card"
              onClick={() => navigate("/sales")}
              onKeyDown={(e) => activate(e, () => navigate("/sales"))}
              role="button"
              tabIndex={0}
              aria-label="Average ticket - view sales"
            >
              <div className="kpi-card-header">
                <span className="kpi-card-label">Avg ticket</span>
                <span className="kpi-card-icon">
                  <ReceiptText size={20} />
                </span>
              </div>
              <div className="kpi-card-value">P{avgTicket.toFixed(0)}</div>
              <div className="kpi-card-sub">Per order today</div>
            </div>

            <div
              className="kpi-card"
              onClick={() => navigate("/analytics")}
              onKeyDown={(e) => activate(e, () => navigate("/analytics"))}
              role="button"
              tabIndex={0}
              aria-label="Top item - view analytics"
            >
              <div className="kpi-card-header">
                <span className="kpi-card-label">Top item</span>
                <span className="kpi-card-icon">
                  <BarChart2 size={20} />
                </span>
              </div>
              <div className="kpi-card-value" style={{ fontSize: "var(--fs-lg)", fontWeight: "var(--fw-extrabold)" }}>
                {topItem ? (topItem.flavor ?? topItem.name) : "-"}
              </div>
              <div className="kpi-card-sub">
                {topItem ? `${topItem.qty ?? 0} sold (7d)` : "No data yet"}
              </div>
            </div>

            <div
              className="kpi-card"
              onClick={() => navigate("/inventory")}
              onKeyDown={(e) => activate(e, () => navigate("/inventory"))}
              role="button"
              tabIndex={0}
              aria-label="Low stock - view inventory"
            >
              <div className="kpi-card-header">
                <span className="kpi-card-label">Low stock</span>
                <span
                  className="kpi-card-icon"
                  style={
                    lowCount > 0
                      ? { background: "var(--danger-bg)", color: "var(--danger)" }
                      : undefined
                  }
                >
                  <AlertTriangle size={20} />
                </span>
              </div>
              <div
                className="kpi-card-value"
                style={lowCount > 0 ? { color: "var(--danger)" } : undefined}
              >
                {lowCount}
              </div>
              <div className="kpi-card-sub">
                {criticalCount} critical - {lowStockAlerts.length} alert
                {lowStockAlerts.length !== 1 ? "s" : ""}
              </div>
            </div>

            <div
              className="kpi-card"
              onClick={() => navigate("/staff")}
              onKeyDown={(e) => activate(e, () => navigate("/staff"))}
              role="button"
              tabIndex={0}
              aria-label="Staff on shift - view staff"
            >
              <div className="kpi-card-header">
                <span className="kpi-card-label">On shift</span>
                <span className="kpi-card-icon">
                  <Users size={20} />
                </span>
              </div>
              <div className="kpi-card-value">{onShift.length}</div>
              <div className="kpi-card-sub">
                {onShift.length > 0
                  ? onShift.map((s) => s.location_code).join(", ")
                  : "No staff tapped in"}
              </div>
            </div>
          </div>

          {/* COLUMN 3: Chart Widget */}
          {trends && trends.by_weekday ? (
            <section className="panel dashboard-trend-panel">
              <div className="panel-head">
                <h3 className="section-title flex items-center gap-2" style={{ borderBottom: "none", margin: 0, padding: 0 }}>
                  Weekly sales trend
                </h3>
                <Badge variant="brand">
                  P{Number(trends.total_sales).toLocaleString()}
                </Badge>
              </div>
              <div className="trend-bars mt-2">
                {trends.by_weekday.map((d) => {
                  const pct = (d.total_sales / weeklyMax) * 100;
                  return (
                    <div
                      key={d.dow}
                      className="trend-bar-col"
                      title={`P${Number(d.total_sales).toLocaleString()} - ${d.orders ?? 0} orders`}
                    >
                      <div className="trend-bar" style={{ height: `${Math.max(pct, 2)}%` }} />
                      <span className="muted small">{d.label}</span>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : (
            <div className="panel dashboard-trend-panel" style={{ display: 'grid', placeItems: 'center' }}>
              <EmptyState icon={TrendingUp} title="No trend data" compact />
            </div>
          )}
        </div>
      )}

      {/* BOTTOM SECTION */}
      {!loading && (
        <div className="dashboard-body">
          
          {/* ROW 1 ================================= */}
          
          {/* 1. Recent Orders (Spans 2 columns) */}
          <section className="panel widget-orders" aria-live="polite">
            <div className="panel-head" style={{ marginBottom: "16px" }}>
              <h3 className="section-title flex items-center gap-2" style={{ borderBottom: "none", padding: 0, margin: 0 }}>
                Recent orders
              </h3>
              <button className="ghost small-btn" onClick={() => navigate("/sales")}>
                View all
              </button>
            </div>
            {latestSales.length === 0 ? (
              <EmptyState
                icon={ShoppingBag}
                title="No sales today"
                subtitle="Sales appear here as soon as staff records them."
                compact
              />
            ) : (
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
                    {latestSales.map((o) => (
                      <tr key={o.id}>
                        <td className="text-xs muted">{formatTime(o.createdAt)}</td>
                        <td className="text-xs">
                          {o.items
                            .map((i) => `${i.qty}x ${i.productName}${i.flavor ? ` (${i.flavor})` : ""}`)
                            .join(", ")}
                        </td>
                        <td className="t-right">
                          <strong>P{Number(o.total).toLocaleString()}</strong>
                        </td>
                        <td>
                          <Badge variant="neutral">
                            {(o.paymentMethod || "CASH").toUpperCase()}
                          </Badge>
                        </td>
                        <td>
                          <Badge variant="info">{o.location?.code}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* 2. Live Sensor (Spans 1 column naturally) */}
          <SensorPanel code="CART-01" />


          {/* ROW 2 ================================= */}

          {/* 3. Stock Alerts (Spans 1 column) */}
          <section className="panel">
            <div className="panel-head" style={{ marginBottom: "12px" }}>
              <h3 className="section-title flex items-center gap-2" style={{ borderBottom: "none", padding: 0, margin: 0 }}>
                Stock alerts
              </h3>
              <div className="flex items-center gap-2">
                {alerts.length > 0 && (
                  <button
                    className="ghost small-btn"
                    onClick={async () => {
                      try {
                        await api.patch("/alerts/read", {});
                        const alr = await api.get("/alerts?unread_only=true&page=1&pageSize=6");
                        setAlerts(alr.data.data);
                        toast("All alerts marked as read", "success");
                      } catch {
                        toast("Failed to mark alerts as read", "error");
                      }
                    }}
                    title="Mark all alerts as read"
                  >
                    Mark all read
                  </button>
                )}
                <button className="ghost small-btn" onClick={() => navigate("/inventory")}>
                  View inventory
                </button>
              </div>
            </div>
            {inventory.length === 0 ? (
              <EmptyState
                icon={Boxes}
                title="No carts configured"
                subtitle="Stock alerts appear as soon as a cart reports readings."
                compact
              />
            ) : (
              <div>
                {inventory
                  .flatMap((loc) =>
                    loc.items
                      .filter((i) => i.status !== "ok")
                      .map((i) => ({ ...i, locationCode: loc.code }))
                  )
                  .slice(0, 6)
                  .map((it) => {
                    const Icon = it.status === "critical" ? AlertTriangle : Info;
                    return (
                      <div className="alert-item" key={`${it.id}`}>
                        <span className="alert-item-icon">
                          <Icon
                            size={16}
                            style={{ color: it.status === "critical" ? "var(--danger)" : "var(--warn)" }}
                          />
                        </span>
                        <span className="alert-item-text">
                          <div className="alert-item-name">
                            {it.name} <span className="text-xs muted">@ {it.locationCode}</span>
                          </div>
                          <div className="alert-item-detail">
                            {it.stock} {it.unit} remaining - threshold {it.threshold}
                          </div>
                        </span>
                        <Badge variant={statusClass(it.status)}>
                          {it.status.toUpperCase()}
                        </Badge>
                      </div>
                    );
                  })}
                {inventory.every((loc) => loc.items.every((i) => i.status === "ok")) && (
                  <EmptyState
                    icon={CheckCircle}
                    title="All stock healthy"
                    subtitle="Nothing below threshold right now."
                    compact
                  />
                )}
              </div>
            )}
          </section>

          {/* 4. Cart Status (Spans 1 column) */}
          {inventory.length > 0 && (
            <section className="panel">
              <div className="panel-head" style={{ marginBottom: "12px" }}>
                <h3 className="section-title flex items-center gap-2" style={{ borderBottom: "none", padding: 0, margin: 0 }}>
                  Cart status
                </h3>
                <Badge variant="neutral">{inventory.length} carts</Badge>
              </div>
              <div>
                {inventory.map((loc) => {
                  const low = loc.items.filter((i) => i.status !== "ok").length;
                  const critical = loc.items.filter((i) => i.status === "critical").length;
                  const dotClass = critical > 0 ? "critical" : low > 0 ? "warn" : "ok";

                  return (
                    <div
                      key={loc.id}
                      className="cart-status-item"
                      onClick={() => navigate("/inventory")}
                      onKeyDown={(e) => activate(e, () => navigate("/inventory"))}
                      role="button"
                      tabIndex={0}
                      aria-label={`${loc.code} stock status - view inventory`}
                    >
                      <span className={`status-dot ${dotClass}`} />
                      <span className="alert-item-text">
                        <div className="alert-item-name">{loc.code}</div>
                        <div className="alert-item-detail">
                          {loc.name} - {loc.items.length} items
                        </div>
                      </span>
                      <Badge variant={critical > 0 ? "danger" : low > 0 ? "warn" : "ok"}>
                        {critical > 0
                          ? `${critical} critical`
                          : low > 0
                            ? `${low} low`
                            : "OK"}
                      </Badge>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* 5. On-shift Staff (Spans 1 column) */}
          <section className="panel">
            <div className="panel-head" style={{ marginBottom: "12px" }}>
              <h3 className="section-title flex items-center gap-2" style={{ borderBottom: "none", padding: 0, margin: 0 }}>
                On-shift staff
              </h3>
              <Badge variant={onShift.length > 0 ? "ok" : "neutral"}>
                {onShift.length} on duty
              </Badge>
            </div>
            {onShift.length === 0 ? (
              <EmptyState
                icon={Clock}
                title="No one on shift"
                subtitle="Staff will appear here when they tap in."
                compact
              />
            ) : (
              <div className="flex flex-col gap-2">
                {onShift.map((s) => (
                  <div
                    key={`${s.name}-${s.location_code}`}
                    className="cart-status-item"
                    style={{ borderBottom: "none" }}
                  >
                    <span className="staff-avatar">{initials(s.name)}</span>
                    <span className="alert-item-text">
                      <div className="alert-item-name">{s.name}</div>
                      <div className="alert-item-detail">
                        {s.location_name} - since {formatTime(s.since)}
                      </div>
                    </span>
                    <Badge variant={s.registered ? "ok" : "danger"}>
                      {s.registered ? "ON" : "UNREG"}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </section>

        </div>
      )}
    </div>
  );
}