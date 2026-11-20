import { useEffect, useState, useCallback, useMemo } from "react";
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
  ShoppingBag,
  TrendingUp,
  X,
  ChevronRight,
  Banknote,
  CreditCard
} from "lucide-react";
import { 
  BarChart, 
  Bar, 
  XAxis, 
  Tooltip as RechartsTooltip, 
  ResponsiveContainer 
} from "recharts";

import api from "../api.js";
import { getFriendlyError } from "../utils/errors.js";
import { addCartBreakdowns } from "../utils/analytics.js";
import { useLiveList } from "../state/liveData.js";
import Badge from "../components/Badge.jsx";
import EmptyState from "../components/EmptyState.jsx";
import PageErrorBoundary from "../components/PageErrorBoundary.jsx";
import Skeleton, { SkeletonCards, SkeletonList, TableSkeleton } from "../components/Skeleton.jsx";
import Select from "../components/Select.jsx";
import { useLiveEvent, useLiveStatus } from "../hooks/useLiveStream.js";

// Exact colors matching the CartIQ theme system variables
const CHART_COLORS = [
  "var(--primary)",           // Base Brand Red (#E73631)
  "#F87171",                  // Light Red-Orange
  "var(--primary-strong)",    // Darker Brand Red (#C72824)
  "#FCA5A5",                  // Soft Light Red
  "#991B1B",                  // Deep Dark Red
  "#FECACA",                  // Pale Red
  "#7F1D1D"                   // Very Dark Red
];

function statusClass(s) {
  if (s === "out") return "danger";
  if (s === "low") return "warn";
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
  if (dir === "up") return <ArrowUp size={14} />;
  if (dir === "down") return <ArrowDown size={14} />;
  return <Minus size={14} />;
}

function getLocalToday() {
  const tzOffset = new Date().getTimezoneOffset() * 60000;
  return new Date(Date.now() - tzOffset).toISOString().slice(0, 10);
}

export function previousDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ""));
  if (!m) return "";
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function formatStock(val) {
  return Number(val).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const { user } = useOutletContext();
  const firstName = user?.name ? user.name.split(" ")[0] : "there";

  const [report, setReport] = useState(null);
  const [inventory, setInventory] = useState([]);
  const [onShift, setOnShift] = useState([]);
  const [latestSales, setLatestSales] = useState([]);
  const [, setAlerts] = useState([]);
  const [trends, setTrends] = useState(null);
  const [prev, setPrev] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sectionErrors, setSectionErrors] = useState({});

  const { data: cartList } = useLiveList("carts");
  const locations = useMemo(
    () => (Array.isArray(cartList) ? cartList : []),
    [cartList]
  );
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

  const refresh = useCallback(async () => {
    const startedAt = performance.now();
    const schedule = () => {
      if (import.meta.env.DEV) {
        console.debug(`[perf] Dashboard refresh completed in ${Math.round(performance.now() - startedAt)}ms`);
      }
    };

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
    const prevQ = dateFilter ? `date=${previousDay(dateFilter)}` : "daysAgo=1";

    const buildQ = (base, params) => {
      const query = params.filter(Boolean).join("&");
      if (!query) return base;
      return base.includes("?") ? `${base}&${query}` : `${base}?${query}`;
    };

    // The chart shows "All carts" by stacking one series per cart. The API
    // returns per-cart keys only when asked for that cart, so fetch each active
    // cart in parallel and merge the weekday series onto the aggregate.
    const trendsRequest = cartFilter
      ? api.get(buildQ("/analytics/trends?days=7", [cQ]))
      : Promise.all([
          api.get("/analytics/trends?days=7").catch(() => ({ data: null })),
          ...locations
            .filter((loc) => loc.status !== "INACTIVE" && loc.code)
            .map(async (loc) => {
              try {
                const { data } = await api.get(`/analytics/trends?days=7&code=${encodeURIComponent(loc.code)}`);
                if (data.location !== loc.code) {
                  throw new Error(`Cart "${loc.code}" was not found.`);
                }
                return { code: loc.code, data };
              } catch {
                return { code: loc.code, data: null };
              }
            }),
        ]).then(([aggregate, ...cartResults]) => ({
          data: addCartBreakdowns(
            aggregate.data,
            cartResults.filter((result) => result.data)
          ),
        }));

    await Promise.all([
      settle("report", api.get(buildQ("/reports/daily", [dQ, cQ])), (r) => setReport(r.data)),
      settle("inventory", api.get("/inventory"), (r) => setInventory(r.data?.locations ?? [])),
      settle("staff", api.get("/staff/on-shift"), (r) => setOnShift(r.data?.on_shift ?? [])),
      settle("sales", api.get(buildQ("/orders?page=1&pageSize=5", [dQ, lQ])), (r) => setLatestSales(r.data?.data ?? [])),
      settle("trends", trendsRequest.catch(() => ({ data: null })), (r) => setTrends(r.data)),
      settle("prev", api.get(buildQ("/reports/daily", [prevQ, cQ])).catch(() => ({ data: null })), (r) => setPrev(r.data)),
    ]);

    setSectionErrors(errs);
    setLoading(false);
    schedule();
  }, [dateFilter, cartFilter, locations]);

  useEffect(() => {
    const timer = setTimeout(refresh, 0);
    const t = setInterval(refresh, 60000);
    return () => { clearTimeout(timer); clearInterval(t); };
  }, [refresh]);

  useLiveStatus(setSseStatus);

  useLiveEvent("order:new", (data) => {
    if (dateFilter && dateFilter !== getLocalToday()) return;
    if (cartFilter && data?.locationCode && data.locationCode !== cartFilter) return;
    setReport((r) =>
      r
        ? {
            ...r,
            total_sales: (r.total_sales ?? 0) + (data?.total ?? 0),
            orders: (r.orders ?? 0) + 1,
          }
        : r
    );
    setLivePulse((n) => n + 1);
  });

  useLiveEvent("alert:new", (data) => {
    setAlerts((a) =>
      [
        { id: data?.id, type: data?.type, message: data?.message },
        ...(Array.isArray(a) ? a : []),
      ].slice(0, 5)
    );
  });

  const safeInventory = Array.isArray(inventory) ? inventory : [];
  const safeOnShift = Array.isArray(onShift) ? onShift : [];
  const safeLatestSales = Array.isArray(latestSales) ? latestSales : [];

  const inactiveCartsKnown = locations.length > 0;
  const isActiveCart = (code) =>
    !inactiveCartsKnown || locations.some((l) => l.code === code && l.status !== "INACTIVE");

  const activeInventoryBase = safeInventory.filter((l) => isActiveCart(l.code));
  const activeInventory = cartFilter && activeInventoryBase.some((l) => l.code === cartFilter)
    ? activeInventoryBase.filter((l) => l.code === cartFilter)
    : activeInventoryBase;

  const activeOnShift = cartFilter
    ? safeOnShift.filter((s) => s.location_code === cartFilter)
    : safeOnShift.filter((s) => isActiveCart(s.location_code));

  const todaySales = report?.total_sales ?? 0;
  const todayOrders = report?.orders ?? 0;
  const avgTicket = todayOrders > 0 ? todaySales / todayOrders : 0;

  const topItem = (() => {
    const all = trends?.top_items ?? [];
    if (all.length === 0) return null;
    return [...all].sort((a, b) => (b.qty ?? 0) - (a.qty ?? 0))[0];
  })();

  const pct = (today, was) => was != null && was > 0 ? ((today - was) / was) * 100 : null;
  const dirOf = (d) => (d == null ? "flat" : d > 0 ? "up" : d < 0 ? "down" : "flat");
  const labelOf = (d) => d == null ? "No prior data" : `${d >= 0 ? "+" : ""}${d.toFixed(1)}% vs prior`;

  const salesDelta = pct(todaySales, prev?.total_sales);
  const ordersDelta = pct(todayOrders, prev?.orders);
  const salesDir = dirOf(salesDelta);
  const ordersDir = dirOf(ordersDelta);

  const locationOptions = [
    { value: "", label: "All carts" },
    ...locations.filter((l) => l.status !== "INACTIVE" || l.code === cartFilter)
      .map((l) => ({ value: l.code, label: l.code }))
  ];

  // Map Weekly Sales Trend data for Recharts using real API data only
  const weeklyChartData = trends?.by_weekday || [];

  // One stacked series per cart that actually returned a weekday series.
  const breakdownCarts = cartFilter
    ? []
    : activeInventory.filter((loc) =>
        weeklyChartData.some((d) => d[loc.code] !== undefined)
      );
  const hasCartBreakdown = breakdownCarts.length > 0;

  return (
    <PageErrorBoundary>
      <div className="page-container wide">
        <div className="page-header">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="page-header-title">Hello, {firstName}</h1>
              <span
                className={`sse-pill ${sseStatus === "open" ? "open" : sseStatus === "down" ? "down" : sseStatus === "paused" ? "paused" : "connecting"}`}
                title={
                  sseStatus === "paused"
                    ? "Live stream paused while this tab is hidden - it resumes when you come back"
                    : `Live stream: ${sseStatus}`
                }
                aria-label={`Connection status: ${sseStatus}`}
              >
                <Radio
                  size={11}
                  className={sseStatus === "open" ? "spin" : ""}
                  style={sseStatus === "open" ? { animation: "pulse-dot 1.6s ease-in-out infinite" } : undefined}
                />
                {sseStatus === "open"
                  ? "Live"
                  : sseStatus === "down"
                    ? "Offline"
                    : sseStatus === "paused"
                      ? "Paused"
                      : "Connecting"}
              </span>
              {livePulse > 0 && (
                <span className="live-badge" aria-label={`${livePulse} live updates`}>
                  {livePulse}
                </span>
              )}
            </div>
            <p className="page-header-subtitle">
              {loading ? "Syncing data..." : "Overview of today's operations"}
            </p>
          </div>
          
          <div className="page-header-actions" style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end', marginLeft: 'auto' }}>
            <Select value={cartFilter} onChange={setCartFilter} options={locationOptions} placeholder="All carts" />
            <input
              type="date"
              value={dateFilter}
              onChange={e => setDateFilter(e.target.value)}
              style={{ height: '48px', borderRadius: 'var(--radius)', border: '1px solid var(--border)', padding: '0 12px', background: 'var(--surface-alt)', color: 'var(--text)' }}
            />
            {(dateFilter || cartFilter) && (
               <button className="danger-ghost small-btn" onClick={() => { setDateFilter(""); setCartFilter(""); }}>
                  <X size={14} /> Clear
               </button>
            )}
          </div>
        </div>

        {Object.keys(sectionErrors).length > 0 && !loading && (
          <div className="error-box" role="alert" style={{ marginBottom: "var(--space-4)" }}>
            {"Couldn't refresh: "}
            {Object.keys(sectionErrors).map((k) => sectionLabels[k] ?? k).join(", ")}. Showing available data.{" "}
            <button type="button" className="linklike" onClick={refresh}>Retry</button>
          </div>
        )}

        {loading ? (
          <>
            <SkeletonCards count={4} className="dashboard-kpi-strip" />
            <div className="dashboard-middle-row">
              <div className="panel dashboard-trend-panel" style={{ display: "flex", flexDirection: "column" }}>
                <div className="panel-head" style={{ marginBottom: "16px" }}>
                   <Skeleton rows={1} height={24} />
                </div>
                <div style={{ flex: 1 }}>
                  <Skeleton rows={1} height={140} />
                </div>
              </div>
              <div className="panel" style={{ display: "flex", flexDirection: "column" }}>
                <div className="panel-head" style={{ marginBottom: "16px" }}>
                   <Skeleton rows={1} height={24} />
                </div>
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "12px" }}>
                  <SkeletonList rows={3} />
                </div>
              </div>
            </div>
            
            <div className="dashboard-middle-row">
              <section className="panel widget-orders" style={{ display: "flex", flexDirection: "column", minHeight: "320px" }}>
                <div className="panel-head" style={{ marginBottom: "16px" }}>
                  <div style={{ width: "140px" }}><Skeleton rows={1} height={24} /></div>
                  <div style={{ width: "80px" }}><Skeleton rows={1} height={28} /></div>
                </div>
                <TableSkeleton
                  rows={5}
                  columns={[
                    { key: "time", label: "Time" },
                    { key: "items", label: "Items" },
                    { key: "total", label: "Total", align: "right" },
                    { key: "payment", label: "Payment" },
                    { key: "location", label: "Location" },
                  ]}
                />
              </section>
              
              <section className="panel" style={{ display: "flex", flexDirection: "column", minHeight: "280px" }}>
                <div className="panel-head" style={{ marginBottom: "16px" }}>
                  <div style={{ width: "130px" }}><Skeleton rows={1} height={24} /></div>
                  <div style={{ width: "80px" }}><Skeleton rows={1} height={24} /></div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "12px", flex: 1 }}>
                  <SkeletonList rows={4} />
                </div>
              </section>
            </div>
          </>
        ) : (
          <>
            {/* ROW 1: CORE KPIs */}
            <div className="dashboard-kpi-strip">
              <div
                className="kpi-card solid-brand"
                onClick={() => navigate("/sales")}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    navigate("/sales");
                  }
                }}
                role="button"
                tabIndex={0}
              >
                <div className="kpi-card-header">
                  <span className="kpi-card-label">{dateFilter ? "Sales (Filtered)" : "Sales today"}</span>
                  <span className="kpi-card-icon"><DollarSign size={22} /></span>
                </div>
                <div className="kpi-card-body">
                  <div>
                    <div className="kpi-card-value">{report ? <>P{Number(todaySales).toLocaleString()}</> : "—"}</div>
                    <div className="kpi-card-sub flex items-center gap-1">
                      {report ? <><ShoppingBag size={12}/> {todayOrders} orders</> : "—"}
                    </div>
                  </div>
                  <span className="kpi-card-trend"><TrendArrow dir={salesDir} /> {labelOf(salesDelta)}</span>
                </div>
              </div>
              
              <div
                className="kpi-card"
                onClick={() => navigate("/sales")}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    navigate("/sales");
                  }
                }}
                role="button"
                tabIndex={0}
              >
                <div className="kpi-card-header">
                  <span className="kpi-card-label">{dateFilter ? "Orders (Filtered)" : "Orders today"}</span>
                  <span className="kpi-card-icon"><ShoppingBag size={22} /></span>
                </div>
                <div className="kpi-card-body">
                  <div>
                    <div className="kpi-card-value">{report ? todayOrders : "—"}</div>
                    <div className="kpi-card-sub flex items-center gap-1">
                      <Boxes size={12}/> {activeInventory.length} Active Carts
                    </div>
                  </div>
                  <span className={`kpi-card-trend ${ordersDir}`}><TrendArrow dir={ordersDir} /> {labelOf(ordersDelta)}</span>
                </div>
              </div>

              <div
                className="kpi-card"
                onClick={() => navigate("/sales")}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    navigate("/sales");
                  }
                }}
                role="button"
                tabIndex={0}
              >
                <div className="kpi-card-header">
                  <span className="kpi-card-label">Avg ticket</span>
                  <span className="kpi-card-icon"><ReceiptText size={20} /></span>
                </div>
                <div className="kpi-card-value">{report ? <>P{avgTicket.toFixed(0)}</> : "—"}</div>
                <div className="kpi-card-sub">
                  <Badge variant="neutral">Per Order</Badge>
                </div>
              </div>

              <div
                className="kpi-card"
                onClick={() => navigate("/analytics")}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    navigate("/analytics");
                  }
                }}
                role="button"
                tabIndex={0}
              >
                <div className="kpi-card-header">
                  <span className="kpi-card-label">Top item</span>
                  <span className="kpi-card-icon"><BarChart2 size={20} /></span>
                </div>
                <div className="kpi-card-value" style={{ fontSize: "var(--fs-lg)", fontWeight: "var(--fw-extrabold)" }}>
                  {topItem ? (topItem.flavor ?? topItem.name) : "—"}
                </div>
                <div className="kpi-card-sub">
                  {topItem ? <Badge variant="brand">{topItem.qty ?? 0} sold (7d)</Badge> : "No data yet"}
                </div>
              </div>
            </div>

            {/* ROW 2: TRENDS & COMBINED CART STATUS */}
            <div className="dashboard-middle-row">
              {trends && trends.by_weekday ? (
                <section className="panel dashboard-trend-panel" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
                  <div className="panel-head">
                    <h3 className="section-title flex items-center gap-2" style={{ borderBottom: "none", margin: 0, padding: 0 }}>
                      Weekly sales trend
                    </h3>
                    <Badge variant="brand">P{Number(trends.total_sales).toLocaleString()}</Badge>
                  </div>
                  
                  <div className="trend-bars mt-2" style={{ flex: 1, minHeight: 180, width: "100%" }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={weeklyChartData} margin={{ top: 10, right: 0, left: 0, bottom: 0 }} maxBarSize={36}>
                        <XAxis 
                          dataKey="label" 
                          axisLine={false} 
                          tickLine={false} 
                          tick={{ fontSize: 11, fill: "var(--text-muted)", fontWeight: 600 }} 
                          dy={10}
                        />
                        <RechartsTooltip
                          cursor={{ fill: "var(--surface-alt)" }}
                          contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "8px", fontSize: "12px", fontWeight: 600 }}
                          formatter={(value, name) => [
                            `P${Number(value).toLocaleString()}`, 
                            name === "total_sales" ? "Total Revenue" : name
                          ]}
                        />
                        
                        {hasCartBreakdown ? (
                          breakdownCarts.map((loc, idx) => (
                            <Bar 
                              key={loc.code} 
                              dataKey={loc.code} 
                              name={loc.code}
                              stackId="a" 
                              fill={CHART_COLORS[idx % CHART_COLORS.length]}
                              stroke="var(--surface)"
                              strokeWidth={2}
                              radius={idx === breakdownCarts.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]}
                            />
                          ))
                        ) : (
                          <Bar 
                            dataKey="total_sales" 
                            fill="var(--primary)" 
                            radius={[99, 99, 0, 0]} 
                          />
                        )}
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </section>
              ) : (
                <div className="panel dashboard-trend-panel" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
                  <EmptyState icon={TrendingUp} title="No trend data" compact />
                </div>
              )}
              
              <section className="panel" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
                <div className="panel-head" style={{ marginBottom: "12px" }}>
                  <h3 className="section-title flex items-center gap-2" style={{ borderBottom: "none", padding: 0, margin: 0 }}>
                    Cart status
                  </h3>
                  <Badge variant="neutral">{activeInventory.length} active</Badge>
                </div>
                <div style={{ display: "flex", flexDirection: "column", flex: 1, gap: "10px" }}>
                  {activeInventory.length === 0 ? (
                     <EmptyState icon={Boxes} title="No carts configured" subtitle="Carts appear once added." compact />
                  ) : (
                    <>
                      {activeInventory.slice(0, 5).map((loc) => {
                        const locItems = loc.items ?? [];
                        const lowItems = locItems.filter((i) => i.status === "low");
                        const outItems = locItems.filter((i) => i.status === "out");
                        
                        const low = lowItems.length;
                        const critical = outItems.length;
                        const dotClass = critical > 0 ? "critical" : low > 0 ? "warn" : "ok";
                        
                        return (
                          <div 
                            key={loc.id} 
                            className="cart-status-item" 
                            style={{ 
                              flexDirection: "column", 
                              alignItems: "flex-start", 
                              gap: "8px", 
                              padding: "12px", 
                              background: "var(--surface-alt)", 
                              borderRadius: "var(--radius-sm)", 
                              border: "1px solid var(--border)",
                              margin: 0
                            }} 
                            onClick={() => navigate("/inventory", { state: { cartCode: loc.code } })} 
                            role="button" 
                            tabIndex={0}
                          >
                            <div className="flex justify-between items-center w-full">
                              <div className="flex items-center gap-2">
                                <span className={`status-dot ${dotClass}`} style={{ width: 10, height: 10 }} />
                                <span className="font-bold">{loc.code}</span>
                                <span className="text-xs muted flex items-center gap-1"><Boxes size={12}/> {locItems.length} items</span>
                              </div>
                              <Badge variant={critical > 0 ? "danger" : low > 0 ? "warn" : "ok"}>
                                {critical > 0 ? `${critical} critical` : low > 0 ? `${low} low` : "All OK"}
                              </Badge>
                            </div>
                            
                            {(critical > 0 || low > 0) && (
                              <div className="flex flex-wrap gap-1 mt-1">
                                {outItems.map(i => (
                                  <span key={i.id} className="text-xs flex items-center gap-1 px-2 py-1 rounded-full" style={{ background: "var(--danger-bg)", color: "var(--danger)" }}>
                                    <AlertTriangle size={10} /> {i.name} ({formatStock(i.stock)}{i.unit})
                                  </span>
                                ))}
                                {lowItems.map(i => (
                                  <span key={i.id} className="text-xs flex items-center gap-1 px-2 py-1 rounded-full" style={{ background: "var(--warn-bg)", color: "var(--warn)" }}>
                                    <Info size={10} /> {i.name} ({formatStock(i.stock)}{i.unit})
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                      <div style={{ marginTop: "auto", paddingTop: "8px", display: "flex", justifyContent: "center" }}>
                        <button className="ghost small-btn" onClick={() => navigate("/settings")}>
                          Manage carts <ChevronRight size={14} />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </section>
            </div>

            {/* ROW 3: RECENT ORDERS & ON-SHIFT STAFF */}
            <div className="dashboard-middle-row">
              <section className="panel widget-orders" aria-live="polite">
                <div className="panel-head">
                  <h3 className="section-title flex items-center gap-2" style={{ borderBottom: "none", padding: 0, margin: 0 }}>
                    Recent orders
                  </h3>
                  <button className="ghost small-btn" onClick={() => navigate("/sales")}>
                    View all <ChevronRight size={14}/>
                  </button>
                </div>

                {safeLatestSales.length === 0 ? (
                  <EmptyState icon={ShoppingBag} title="No sales found" compact />
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
                    <div className="table-wrap">
                      <table className="data">
                        <thead>
                          <tr>
                            <th>Time</th>
                            <th>Items</th>
                            <th className="t-left">Total</th>
                            <th>Payment</th>
                            <th>Location</th>
                          </tr>
                        </thead>
                        <tbody>
                          {safeLatestSales.map((o) => (
                            <tr key={o.id}>
                              <td className="text-xs muted">{formatTime(o.createdAt)}</td>
                              <td className="text-xs">
                                <div className="flex flex-col gap-1">
                                  {(o.items ?? []).map((i, idx) => (
                                    <span key={idx} className="flex items-center gap-2">
                                      <Badge variant="brand">{i.qty}x</Badge> 
                                      <span className="fw-medium">{i.productName}{i.flavor ? ` (${i.flavor})` : ""}</span>
                                    </span>
                                  ))}
                                </div>
                              </td>
                              <td className="t-left"><strong style={{ fontSize: "1.1em" }}>P{Number(o.total).toLocaleString()}</strong></td>
                              <td>
                                <div className="flex items-center gap-2">
                                  {o.paymentMethod === "CASH" ? <Banknote size={14} className="muted"/> : <CreditCard size={14} className="muted"/>}
                                  <Badge variant="neutral">{(o.paymentMethod || "CASH").toUpperCase()}</Badge>
                                </div>
                              </td>
                              <td><Badge variant="info">{o.location?.code}</Badge></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </section>

              <section className="panel" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
                <div className="panel-head" style={{ marginBottom: "12px" }}>
                  <h3 className="section-title flex items-center gap-2" style={{ borderBottom: "none", padding: 0, margin: 0 }}>
                    On-shift staff
                  </h3>
                  <Badge variant={activeOnShift.length > 0 ? "ok" : "neutral"}>{activeOnShift.length} on duty</Badge>
                </div>
                
                {activeOnShift.length === 0 ? (
                  <EmptyState icon={Clock} title="No one on shift" compact />
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
                    <div className="flex flex-col gap-2">
                      {activeOnShift.slice(0, 5).map((s) => (
                        <div key={`${s.name}-${s.location_code}`} className="cart-status-item" style={{ borderBottom: "none" }}>
                          <span className="staff-avatar">{initials(s.name)}</span>
                          <span className="alert-item-text">
                            <div className="alert-item-name">{s.name}</div>
                            <div className="text-xs muted flex items-center gap-1">
                              <Badge variant="neutral">{s.location_name}</Badge>
                              <Clock size={12} className="ml-1" /> {formatTime(s.since)}
                            </div>
                          </span>
                          <Badge variant={s.registered ? "ok" : "danger"}>{s.registered ? "ON" : "UNREG"}</Badge>
                        </div>
                      ))}
                    </div>
                    <div style={{ marginTop: "auto", paddingTop: "16px", display: "flex", justifyContent: "center" }}>
                      <button className="ghost small-btn" onClick={() => navigate("/staff")}>
                        View all staff <ChevronRight size={14} />
                      </button>
                    </div>
                  </div>
                )}
              </section>
            </div>
          </>
        )}
      </div>
    </PageErrorBoundary>
  );
}