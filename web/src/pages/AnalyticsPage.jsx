import { useEffect, useState, useMemo, Fragment } from "react";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis,
  Tooltip, ResponsiveContainer, CartesianGrid, Cell, LabelList,
} from "recharts";
import {
  TrendingUp, TrendingDown, ShoppingBag,
  DollarSign, BarChart2, PackageSearch,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import api from "../api.js";
import EmptyState from "../components/EmptyState.jsx";
import { SkeletonCards, SkeletonChart } from "../components/Skeleton.jsx";
import PageErrorBoundary from "../components/PageErrorBoundary.jsx";
import ProfitSection from "../components/analytics/ProfitSection.jsx";
import { fmtMoneyAxis, fmtShortDate } from "../utils/format.js";

// API risk level -> chip color: high red, medium amber, low green.
const RISK_CHIP = { high: "critical", medium: "low", low: "ok", unknown: "read" };

const HEAT_HOURS = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
const HEAT_DAYS = ["S", "M", "T", "W", "T", "F", "S"];

// CSS-grid rush-hour heatmap: rows = weekday, columns = hour of day.
// Color intensity scales with revenue; title tooltips carry exact numbers.
function HeatmapGrid({ matrix }) {
  const byKey = new Map((matrix ?? []).map((c) => [`${c.dow}:${c.hour}`, c]));
  const max = Math.max(1, ...(matrix ?? []).map((c) => c.total_sales));
  return (
    <div className="heat-grid" role="img" aria-label="Heatmap of revenue by weekday and hour">
      <div className="heat-corner" />
      {HEAT_HOURS.map((h) => (
        <span key={h} className="heat-col-label">{h}</span>
      ))}
      {[0, 1, 2, 3, 4, 5, 6].map((dow) => (
        <Fragment key={`row-${dow}`}>
          <span className="heat-row-label">{HEAT_DAYS[dow]}</span>
          {HEAT_HOURS.map((h) => {
            const c = byKey.get(`${dow}:${h}`);
            const v = c?.total_sales ?? 0;
            const t = v / max;
            return (
              <span
                key={`${dow}:${h}`}
                className="heat-cell"
                title={`${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dow]} ${h}:00 — P${v.toLocaleString()} (${c?.orders ?? 0} orders)`}
                style={{
                  backgroundColor: v > 0 ? "var(--primary)" : "var(--surface-alt)",
                  opacity: v > 0 ? 0.15 + 0.85 * t : 1,
                }}
              />
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="recharts-default-tooltip analytics-tooltip">
      <div className="recharts-tooltip-label">{label}</div>
      {payload.map((p, i) => (
        <div key={i} className="recharts-tooltip-item">
          {p.name}: <strong className="tooltip-value">P{typeof p.value === "number" ? p.value.toLocaleString() : p.value}</strong>
        </div>
      ))}
    </div>
  );
}

export default function AnalyticsPage() {
  const navigate = useNavigate();
  const [carts, setCarts] = useState([]);
  const [cartCode, setCartCode] = useState("");
  const [range, setRange] = useState("30");
  const [trends, setTrends] = useState(null);
  const [prevTrends, setPrevTrends] = useState(null);
  const [forecast, setForecast] = useState(null);
  const [profit, setProfit] = useState(null);
  const [hourly, setHourly] = useState(null);
  const [basket, setBasket] = useState(null);
  const [salesFc, setSalesFc] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [sortCol, setSortCol] = useState("sales");
  const [sortDir, setSortDir] = useState("desc");

  useEffect(() => {
    api.get("/catalog").then(({ data }) => setCarts(data.locations ?? [])).catch(() => {});
  }, []);

  // Note: setLoading(true) lives in the filter/retry handlers below, not
  // here - calling setState synchronously inside the effect trips
  // react-hooks/set-state-in-effect.
  useEffect(() => {
    let alive = true;
    const days = Number(range) || 30;
    const codeParam = cartCode ? `&code=${encodeURIComponent(cartCode)}` : "";
    Promise.all([
      api.get(`/analytics/trends?days=${days}${codeParam}`),
      api.get(`/analytics/trends?days=${days * 2}${codeParam}`),
      cartCode ? api.get(`/analytics/forecast?code=${encodeURIComponent(cartCode)}`) : Promise.resolve({ data: { code: null, items: [] } }),
      api.get(`/analytics/profit?days=${days}${codeParam}`),
      api.get(`/analytics/hourly?days=${days}${codeParam}`).catch(() => ({ data: null })),
      api.get(`/analytics/basket?days=${days}${codeParam}`).catch(() => ({ data: null })),
      api.get(`/analytics/sales-forecast?days=${days}${codeParam}`).catch(() => ({ data: null })),
    ])
      .then(([cur, ext, f, pf, hr, bk, sf]) => {
        if (!alive) return;
        setLoading(false);
        const curSales = cur.data.total_sales;
        const extSales = ext.data.total_sales;
        const prevSales = Math.max(0, extSales - curSales);
        setTrends(cur.data);
        setPrevTrends({
          ...cur.data,
          total_sales: prevSales,
          orders: Math.max(0, (ext.data.orders ?? 0) - (cur.data.orders ?? 0)),
        });
        setForecast(f.data);
        setProfit(pf.data);
        setHourly(hr.data);
        setBasket(bk.data);
        setSalesFc(sf.data);
        setError("");
      })
      .catch((err) => {
        if (!alive) return;
        setLoading(false);
        const msg = err.response?.data?.error || err.message || "Unable to load analytics. Please try again.";
        setError(msg);
      });
    return () => { alive = false; };
  }, [range, cartCode, reload]);

  const revenueTrend = useMemo(() => {
    if (!trends || !prevTrends || prevTrends.total_sales <= 0) return null;
    return ((trends.total_sales - prevTrends.total_sales) / prevTrends.total_sales) * 100;
  }, [trends, prevTrends]);

  const ordersTrend = useMemo(() => {
    if (!trends || !prevTrends || prevTrends.orders <= 0) return null;
    return ((trends.orders - prevTrends.orders) / prevTrends.orders) * 100;
  }, [trends, prevTrends]);

  const totalRevenue = trends?.total_sales ?? 0;
  const totalOrders = trends?.orders ?? 0;
  const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;
  const avgTrend = useMemo(() => {
    if (!trends || !prevTrends) return null;
    const curAvg = totalOrders > 0 ? totalRevenue / totalOrders : 0;
    const prevOrders = prevTrends.orders || 1;
    const prevAvg = prevTrends.total_sales / prevOrders;
    if (prevAvg <= 0) return null;
    return ((curAvg - prevAvg) / prevAvg) * 100;
  }, [trends, prevTrends, totalRevenue, totalOrders]);

  const topCategoryName = useMemo(() => {
    if (!trends?.top_items?.length) return "—";
    return trends.top_items[0].name || "—";
  }, [trends]);

  // Takeaway chips pinned under the KPIs: short, linked to the evidence.
  const insights = useMemo(() => {
    const list = [];
    if (revenueTrend !== null && revenueTrend > 10) {
      list.push({ icon: TrendingUp, short: `Revenue +${revenueTrend.toFixed(1)}%`, href: "#section-sales", type: "success" });
    }
    if (revenueTrend !== null && revenueTrend < -5) {
      list.push({ icon: TrendingDown, short: `Revenue ${revenueTrend.toFixed(1)}%`, href: "#section-sales", type: "danger" });
    }
    if (ordersTrend !== null && Math.abs(ordersTrend) >= 5) {
      list.push({ icon: ShoppingBag, short: `Orders ${ordersTrend >= 0 ? "+" : ""}${ordersTrend.toFixed(1)}%`, href: "#section-sales", type: ordersTrend >= 0 ? "success" : "danger" });
    }
    const byWeekday = trends?.by_weekday ?? [];
    if (byWeekday.length) {
      const best = byWeekday.reduce((a, b) => (a.total_sales > b.total_sales ? a : b));
      if (best.total_sales > 0) {
        list.push({ icon: BarChart2, short: `${best.label} peaks — staff it`, href: "#section-dow", type: "info" });
      }
    }
    if (totalOrders > 0) {
      list.push({ icon: ShoppingBag, short: `Avg ticket P${avgOrderValue.toFixed(0)}`, href: "#section-items", type: "info" });
    }
    return list;
  }, [revenueTrend, ordersTrend, trends, totalOrders, avgOrderValue]);

  const categoryData = useMemo(() => {
    const items = trends?.top_items ?? [];
    const byCategory = {};
    for (const item of items) {
      const cat = item.name?.split(" ")[0] ?? "Other";
      if (!byCategory[cat]) byCategory[cat] = 0;
      byCategory[cat] += item.sales;
    }
    const total = Object.values(byCategory).reduce((s, v) => s + v, 0);
    return Object.entries(byCategory)
      .map(([name, sales]) => ({ name, sales: Number(sales.toFixed(2)), pct: total > 0 ? ((sales / total) * 100).toFixed(1) : "0" }))
      .sort((a, b) => b.sales - a.sales)
      .slice(0, 6);
  }, [trends]);

  const dowData = useMemo(() => {
    return (trends?.by_weekday ?? []).map((w) => ({
      ...w,
      fill: w.total_sales > 0 ? "var(--primary)" : "var(--border)",
    }));
  }, [trends]);

  const maxDow = Math.max(...(dowData.map((w) => w.total_sales) ?? [1]), 1);

  // Use brand red for the strongest day and a subtle neutral gradient for the rest
  // (so the bar chart is readable for color-blind users and high-contrast B/W prints).
  function dowCellFill(entry) {
    if (entry.total_sales <= 0) return "var(--border)";
    if (entry.total_sales === maxDow) return "var(--primary)";
    return "var(--primary-soft)";
  }

  const tableData = useMemo(() => {
    const items = trends?.top_items ?? [];
    const total = items.reduce((s, i) => s + i.sales, 0);
    return [...items].map((item, idx) => ({
      ...item,
      rank: idx + 1,
      pct: total > 0 ? ((item.sales / total) * 100).toFixed(1) : "0",
    })).sort((a, b) => {
      const mult = sortDir === "desc" ? -1 : 1;
      return mult * ((a[sortCol] ?? 0) - (b[sortCol] ?? 0));
    });
  }, [trends, sortCol, sortDir]);

  function handleSort(col) {
    if (sortCol === col) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else { setSortCol(col); setSortDir("desc"); }
  }

  function sortIcon(col) {
    if (sortCol !== col) return <span className="sort-icon">↕</span>;
    return <span className="sort-icon active">{sortDir === "desc" ? "↓" : "↑"}</span>;
  }

  return (
    <PageErrorBoundary>
      <div className="page-container" aria-busy={loading}>
        <div className="page-header analytics-sticky">
          <div>
            <h1 className="page-header-title">Analytics</h1>
            <p className="page-header-subtitle">Sales performance and inventory insights</p>
          </div>
          <div className="page-header-actions">
            <select
              className="cart-select"
              value={cartCode}
              onChange={(e) => {
                setLoading(true);
                setCartCode(e.target.value);
              }}
            >
              <option value="">All carts</option>
              {carts.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
            </select>
            <select
              value={range}
              onChange={(e) => {
                setLoading(true);
                setRange(e.target.value);
              }}
            >
              <option value="7">Last 7 days</option>
              <option value="14">Last 14 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
            </select>
          </div>
        </div>

        {error && (
          <div className="error-box" role="alert">
            <span>{error}</span>
            <button
              className="ghost"
              onClick={() => {
                setLoading(true);
                setReload((n) => n + 1);
              }}
            >
              Retry
            </button>
          </div>
        )}

        {trends && (
          <>
            <div className="analytics-kpis">
              {[
                { label: "Total Revenue", value: `P${totalRevenue.toLocaleString()}`, trend: revenueTrend, icon: DollarSign },
                { label: "Total Orders", value: totalOrders, trend: ordersTrend, icon: ShoppingBag },
                { label: "Avg Order Value", value: `P${avgOrderValue.toLocaleString()}`, trend: avgTrend, icon: BarChart2 },
                { label: "Top Item", value: topCategoryName, trend: null, icon: TrendingUp },
              ].map((kpi) => (
                <div key={kpi.label} className="kpi-card">
                  <div className="kpi-card-header">
                    <span className="kpi-card-label">{kpi.label}</span>
                    <div className="kpi-card-icon"><kpi.icon size={18} /></div>
                  </div>
                  <div className="kpi-card-value">{kpi.value}</div>
                  {kpi.trend !== null && (
                    <div className={`kpi-card-trend ${kpi.trend >= 0 ? "up" : "down"}`}>
                      {kpi.trend >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                      {Math.abs(kpi.trend).toFixed(1)}% vs prior period
                    </div>
                  )}
                </div>
              ))}
            </div>

            {insights.length > 0 && (
              <div className="insights-strip" role="region" aria-label="Key takeaways">
                {insights.map((ins, idx) => (
                  <a key={idx} href={ins.href} className={`insight-chip ${ins.type}`}>
                    <ins.icon size={14} />
                    <span>{ins.short}</span>
                  </a>
                ))}
              </div>
            )}

            <div className="analytics-section" id="section-sales">
              <div className="analytics-section-header">
                <div>
                  <h2 className="analytics-section-title"><span className="section-num" aria-hidden="true">1</span> Sales Trend</h2>
                  <p className="analytics-section-sub">Daily revenue — when money comes in</p>
                </div>
              </div>
              <div
                className="chart-container"
                role="img"
                aria-label={`Area chart of daily revenue over the last ${range} days. Total revenue: P${totalRevenue.toLocaleString()}.`}
              >
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={trends.daily_series ?? []} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="salesGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="var(--primary)" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="var(--primary)" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 11, fill: "var(--text-muted)" }}
                      tickLine={false}
                      axisLine={false}
                      interval="preserveStartEnd"
                      minTickGap={24}
                      tickFormatter={fmtShortDate}
                    />
                    <YAxis
                      tick={{ fontSize: 11, fill: "var(--text-muted)" }}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={fmtMoneyAxis}
                      width={52}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <Area
                      type="monotone"
                      dataKey="total_sales"
                      name="Revenue"
                      stroke="var(--primary)"
                      strokeWidth={2}
                      fill="url(#salesGrad)"
                      dot={false}
                      activeDot={{ r: 4, fill: "var(--primary)" }}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="analytics-section" id="section-dow">
              <div className="analytics-section-header">
                <div>
                  <h2 className="analytics-section-title"><span className="section-num" aria-hidden="true">2</span> Day-of-Week Performance</h2>
                  <p className="analytics-section-sub">Peak days drive staffing decisions</p>
                </div>
              </div>
              <div
                className="chart-container"
                role="img"
                aria-label={`Bar chart of revenue by day of week. Best day: ${
                  dowData.find((d) => d.total_sales === maxDow)?.label ?? "n/a"
                } with P${maxDow.toLocaleString()}.`}
              >
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={dowData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 12, fill: "var(--text-muted)" }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      tick={{ fontSize: 11, fill: "var(--text-muted)" }}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={fmtMoneyAxis}
                      width={52}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <Bar
                      dataKey="total_sales"
                      name="Revenue"
                      radius={[4, 4, 0, 0]}
                    >
                      {dowData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={dowCellFill(entry)} />
                      ))}
                      <LabelList
                        dataKey="total_sales"
                        position="top"
                        formatter={(v) => (v === maxDow && v > 0 ? fmtMoneyAxis(v) : "")}
                        style={{ fontSize: 10, fill: "var(--text-muted)", fontWeight: 600 }}
                      />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              {hourly && (
                <div style={{ marginTop: "var(--space-5)" }}>
                  <h3 className="profit-chart-title">Peak hours</h3>
                  <p className="muted small" style={{ marginBottom: "var(--space-2)" }}>
                    {hourly.peak.total_sales > 0 ? (
                      <>Busiest: <strong>{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][hourly.peak.dow]} {hourly.peak.hour}:00</strong> — staff the rush, prep before it.</>
                    ) : (
                      <>No hourly pattern yet — it appears once sales accumulate.</>
                    )}
                  </p>
                  <HeatmapGrid matrix={hourly.matrix} />
                </div>
              )}
            </div>

            {categoryData.length > 0 && (
              <div className="analytics-section" id="section-category">
                <div className="analytics-section-header">
                  <div>
                    <h2 className="analytics-section-title"><span className="section-num" aria-hidden="true">3</span> Category Breakdown</h2>
                    <p className="analytics-section-sub">What sells, by product family</p>
                  </div>
                </div>
              <div
                className="chart-container"
                role="img"
                aria-label={`Horizontal bar chart of revenue by category. Top category: ${
                  categoryData[0]?.name ?? "n/a"
                } at P${categoryData[0]?.sales?.toLocaleString() ?? 0}.`}
              >
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={categoryData}
                    layout="vertical"
                    margin={{ top: 4, right: 16, left: 0, bottom: 0 }}
                  >
                      <XAxis
                        type="number"
                        tick={{ fontSize: 11, fill: "var(--text-muted)" }}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={fmtMoneyAxis}
                      />
                      <YAxis
                        type="category"
                        dataKey="name"
                        tick={{ fontSize: 12, fill: "var(--text-muted)" }}
                        tickLine={false}
                        axisLine={false}
                        width={80}
                      />
                      <Tooltip
                        content={<CustomTooltip />}
                        formatter={(value, name, props) => [`P${Number(value).toLocaleString()} (${props.payload.pct}%)`, name]}
                      />
                      <Bar dataKey="sales" name="Revenue" fill="var(--primary)" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            <div className="analytics-section" id="section-items">
              <div className="analytics-section-header">
                <div>
                  <h2 className="analytics-section-title"><span className="section-num" aria-hidden="true">4</span> Top Items</h2>
                  <p className="analytics-section-sub">Exact products that move the needle</p>
                </div>
              </div>
              <div className="table-wrap">
                <table className="data top-items-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th onClick={() => handleSort("name")}>Item {sortIcon("name")}</th>
                      <th onClick={() => handleSort("qty")} className="t-right">Qty Sold {sortIcon("qty")}</th>
                      <th onClick={() => handleSort("sales")} className="t-right">Revenue {sortIcon("sales")}</th>
                      <th onClick={() => handleSort("pct")} className="t-right">% of Total {sortIcon("pct")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tableData.map((item) => (
                      <tr key={item.rank}>
                        <td className="muted">{item.rank}</td>
                        <td>
                          <strong>{item.name}</strong>
                          {item.flavor && <span className="muted flavor-note">({item.flavor})</span>}
                        </td>
                        <td className="t-right">{item.qty}</td>
                        <td className="t-right">P{Number(item.sales).toLocaleString()}</td>
                        <td className="t-right muted">
                          <span className="pct-bar" aria-hidden="true">
                            <span style={{ width: `${Math.min(100, Number(item.pct) || 0)}%` }} />
                          </span>
                          {item.pct}%
                        </td>
                      </tr>
                    ))}
                    {tableData.length === 0 && (
                      <tr><td colSpan={5} className="empty-state"><strong>No data</strong></td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              {basket && basket.orders > 0 && (
                <div style={{ marginTop: "var(--space-4)" }}>
                  <h3 className="profit-chart-title">What sells together</h3>
                  <div className="profit-strip" aria-label="Basket summary">
                    <span><span className="muted">Units / ticket</span> <strong>{basket.avg_units_per_ticket}</strong></span>
                    <span><span className="muted">Lines / ticket</span> <strong>{basket.avg_lines_per_ticket}</strong></span>
                    <span><span className="muted">Void rate</span> <strong>{basket.void_rate_pct}%</strong></span>
                  </div>
                  {basket.top_pairs.length > 0 ? (
                    <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 6 }}>
                      {basket.top_pairs.map((p, i) => (
                        <li key={i} className="muted small">
                          <span className="pct-bar" aria-hidden="true">
                            <span style={{ width: `${Math.min(100, p.pct * 4)}%` }} />
                          </span>
                          <strong style={{ color: "var(--text)" }}>{p.pair.join(" + ")}</strong>
                          {" "}· {p.orders} orders ({p.pct}%)
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted small">Single-item tickets so far — no pairs to show yet.</p>
                  )}
                </div>
              )}
            </div>

            <div className="analytics-section" id="section-forecast">
              <div className="analytics-section-header">
                <div>
                  <h2 className="analytics-section-title"><span className="section-num" aria-hidden="true">5</span> Inventory Forecast</h2>
                  <p className="analytics-section-sub">What runs out, and when to reorder</p>
                </div>
              </div>
              {(() => {
                const items = forecast?.items ?? [];
                const sufficient = items.filter((i) => i.data_sufficient);
                const insufficient = items.filter((i) => !i.data_sufficient);
                if (items.length === 0) {
                  return (
                    <EmptyState
                      icon={PackageSearch}
                      title="No inventory data"
                      subtitle="Stock readings and historical sales are required to compute a forecast."
                      action={{ label: "Check inventory", variant: "ghost", onClick: () => navigate("/inventory") }}
                      compact
                    />
                  );
                }
                if (sufficient.length === 0) {
                  return (
                    <div className="forecast-empty">
                      <EmptyState
                        icon={PackageSearch}
                        title="No forecast yet"
                        subtitle="Forecasting needs roughly 30 days of stock readings and sales for the selected cart."
                        action={{ label: "Check inventory", variant: "ghost", onClick: () => navigate("/inventory") }}
                        compact
                      />
                      <div className="forecast-progress" role="status" aria-label={`${sufficient.length} of ${items.length} items have enough data`}>
                        <div className="forecast-progress-bar">
                          <span style={{ width: `${items.length > 0 ? (sufficient.length / items.length) * 100 : 0}%` }} />
                        </div>
                        <span className="muted small">{sufficient.length} of {items.length} items have enough data</span>
                      </div>
                      <details className="forecast-note">
                        <summary className="muted small" style={{ cursor: "pointer" }}>
                          {insufficient.length} item(s) still collecting data
                        </summary>
                        <ul style={{ margin: "var(--space-2) 0 0 0", paddingLeft: "var(--space-5)" }}>
                          {insufficient.map((i) => (
                            <li key={i.name} className="muted small">
                              {i.name}: {i.reason || "still collecting data"}
                            </li>
                          ))}
                        </ul>
                      </details>
                    </div>
                  );
                }
                return (
                  <>
                    <p className="muted small" style={{ marginBottom: "var(--space-2)" }}>
                      Forecasting <strong>{sufficient.length}</strong> of
                      {" "}<strong>{items.length}</strong> items.
                      {insufficient.length > 0 && (
                        <> {insufficient.length} item(s) still need more data.</>
                      )}
                    </p>
                    <div className="table-wrap">
                      <table className="data">
                        <thead>
                          <tr>
                            <th>Item</th>
                            <th>Stock</th>
                            <th>Avg/day</th>
                            <th>Depletion</th>
                            <th>MAPE</th>
                            <th>Risk</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sufficient.map((i) => (
                            <tr key={i.name}>
                              <td><strong>{i.name}</strong></td>
                              <td>{i.current_stock} {i.unit}</td>
                              <td>{i.avg_daily_use} {i.unit}</td>
                              <td>{i.depletion_date ?? "—"}</td>
                              <td className="muted">{i.mape_pct != null ? `${i.mape_pct}%` : "—"}</td>
                              <td><span className={`chip ${RISK_CHIP[i.risk] ?? "read"}`}>{String(i.risk ?? "unknown").toUpperCase()}</span></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {insufficient.length > 0 && (
                      <details className="forecast-note">
                        <summary className="muted small" style={{ cursor: "pointer" }}>
                          {insufficient.length} item(s) not yet forecastable
                        </summary>
                        <ul style={{ margin: "var(--space-2) 0 0 0", paddingLeft: "var(--space-5)" }}>
                          {insufficient.map((i) => (
                            <li key={i.name} className="muted small">
                              {i.name}: {i.reason || "still collecting data"}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </>
                );
              })()}
            </div>

            <div className="analytics-section" id="section-revenue-fc">
              <div className="analytics-section-header">
                <div>
                  <h2 className="analytics-section-title"><span className="section-num" aria-hidden="true">6</span> Revenue Forecast</h2>
                  <p className="analytics-section-sub">Expected daily revenue, next 7 days</p>
                </div>
              </div>
              {salesFc && salesFc.data_sufficient && salesFc.forecast?.length > 0 ? (
                <>
                  <p className="muted small" style={{ marginBottom: "var(--space-2)" }}>
                    Same engine as inventory forecasts
                    {salesFc.mape != null && <> · backtest MAPE <strong>{salesFc.mape}%</strong></>}.
                  </p>
                  <div
                    className="chart-container"
                    role="img"
                    aria-label={`Area chart of forecast daily revenue for the next ${salesFc.horizon_days ?? 7} days.`}
                  >
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={salesFc.forecast} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                        <defs>
                          <linearGradient id="revFcGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="var(--highlight-strong)" stopOpacity={0.45} />
                            <stop offset="95%" stopColor="var(--highlight-strong)" stopOpacity={0.03} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                        <XAxis
                          dataKey="date"
                          tick={{ fontSize: 11, fill: "var(--text-muted)" }}
                          tickLine={false}
                          axisLine={false}
                          tickFormatter={fmtShortDate}
                        />
                        <YAxis
                          tick={{ fontSize: 11, fill: "var(--text-muted)" }}
                          tickLine={false}
                          axisLine={false}
                          tickFormatter={fmtMoneyAxis}
                          width={52}
                        />
                        <Tooltip content={<CustomTooltip />} />
                        <Area
                          type="monotone"
                          dataKey="expected_use"
                          name="Expected revenue"
                          stroke="var(--highlight-strong)"
                          strokeWidth={2}
                          strokeDasharray="6 3"
                          fill="url(#revFcGrad)"
                          dot={false}
                          activeDot={{ r: 4, fill: "var(--highlight-strong)" }}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </>
              ) : (
                <p className="muted forecast-empty">
                  {salesFc && !salesFc.data_sufficient
                    ? `Revenue forecast activates after 14 days of sales history${salesFc.reason ? ` (${salesFc.reason})` : ""}.`
                    : "Collecting sales history…"}
                </p>
              )}
            </div>

            {profit && <ProfitSection profit={profit} />}
          </>
        )}

        {loading && !trends && (
          <div className="analytics-loading" role="status" aria-label="Loading analytics">
            <SkeletonCards count={3} />
            <div style={{ marginTop: "var(--space-4)" }}>
              <SkeletonChart />
            </div>
            <span className="muted small">Loading analytics…</span>
          </div>
        )}
      </div>
    </PageErrorBoundary>
  );
}
