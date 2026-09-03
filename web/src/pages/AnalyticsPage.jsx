import { useEffect, useState, useMemo } from "react";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis,
  Tooltip, ResponsiveContainer, CartesianGrid, Cell, LabelList,
} from "recharts";
import {
  TrendingUp, TrendingDown, ShoppingBag,
  DollarSign, BarChart2,
} from "lucide-react";
import api from "../api.js";
import PageErrorBoundary from "../components/PageErrorBoundary.jsx";
import ProfitSection from "../components/analytics/ProfitSection.jsx";

const RISK_CLASS = { high: "critical", medium: "low", low: "ok", unknown: "read" };

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
  const [carts, setCarts] = useState([]);
  const [cartCode, setCartCode] = useState("");
  const [range, setRange] = useState("30");
  const [trends, setTrends] = useState(null);
  const [prevTrends, setPrevTrends] = useState(null);
  const [forecast, setForecast] = useState(null);
  const [profit, setProfit] = useState(null);
  const [error, setError] = useState("");
  const [sortCol, setSortCol] = useState("sales");
  const [sortDir, setSortDir] = useState("desc");

  useEffect(() => {
    api.get("/catalog").then(({ data }) => setCarts(data.locations ?? [])).catch(() => {});
  }, []);

  useEffect(() => {
    let alive = true;
    const days = Number(range) || 30;
    const codeParam = cartCode ? `&code=${encodeURIComponent(cartCode)}` : "";
    Promise.all([
      api.get(`/analytics/trends?days=${days}${codeParam}`),
      api.get(`/analytics/trends?days=${days * 2}${codeParam}`),
      cartCode ? api.get(`/analytics/forecast?code=${encodeURIComponent(cartCode)}`) : Promise.resolve({ data: { code: null, items: [] } }),
      api.get(`/analytics/profit?days=${days}${codeParam}`),
    ])
      .then(([cur, ext, f, pf]) => {
        if (!alive) return;
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
        setError("");
      })
      .catch((err) => {
        if (!alive) return;
        const msg = err.response?.data?.error || err.message || "Unable to load analytics. Please try again.";
        setError(msg);
      });
    return () => { alive = false; };
  }, [range, cartCode]);

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

  const insights = useMemo(() => {
    const list = [];
    if (revenueTrend !== null && revenueTrend > 10) {
      list.push({ icon: TrendingUp, text: `Revenue is up ${revenueTrend.toFixed(1)}% compared to the prior period.`, type: "success" });
    }
    if (revenueTrend !== null && revenueTrend < -5) {
      list.push({ icon: TrendingDown, text: `Revenue declined ${Math.abs(revenueTrend).toFixed(1)}% vs prior period.`, type: "danger" });
    }
    const byWeekday = trends?.by_weekday ?? [];
    if (byWeekday.length) {
      const best = byWeekday.reduce((a, b) => (a.total_sales > b.total_sales ? a : b));
      if (best.total_sales > 0) {
        list.push({ icon: BarChart2, text: `${best.label} is your strongest day, generating the most revenue this period.`, type: "info" });
      }
    }
    if (totalOrders > 0) {
      list.push({ icon: ShoppingBag, text: `An average order is worth P${avgOrderValue.toFixed(0)}, based on ${totalOrders} orders.`, type: "info" });
    }
    return list;
  }, [revenueTrend, trends, totalOrders, avgOrderValue]);

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
      <div className="page-container">
        <div className="page-header">
          <div>
            <h1 className="page-header-title">Analytics</h1>
            <p className="page-header-subtitle">Sales performance and inventory insights</p>
          </div>
          <div className="page-header-actions">
            <select
              className="cart-select"
              value={cartCode}
              onChange={(e) => setCartCode(e.target.value)}
            >
              <option value="">All carts</option>
              {carts.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
            </select>
            <select value={range} onChange={(e) => setRange(e.target.value)}>
              <option value="7">Last 7 days</option>
              <option value="14">Last 14 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
            </select>
          </div>
        </div>

        {error && <div className="error-box">{error}</div>}

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

            <div className="analytics-section">
              <div className="analytics-section-header">
                <h2 className="analytics-section-title">Sales Trend</h2>
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
                    />
                    <YAxis
                      tick={{ fontSize: 11, fill: "var(--text-muted)" }}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v) => `P${(v / 1000).toFixed(0)}k`}
                      width={48}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
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

            <div className="analytics-section">
              <div className="analytics-section-header">
                <h2 className="analytics-section-title">Day-of-Week Performance</h2>
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
                      tickFormatter={(v) => `P${(v / 1000).toFixed(0)}k`}
                      width={48}
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
                        formatter={(v) => (v > 0 ? `P${(v / 1000).toFixed(1)}k` : "")}
                        style={{ fontSize: 10, fill: "var(--text-muted)", fontWeight: 600 }}
                      />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {categoryData.length > 0 && (
              <div className="analytics-section">
                <div className="analytics-section-header">
                  <h2 className="analytics-section-title">Category Breakdown</h2>
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
                    margin={{ top: 4, right: 60, left: 0, bottom: 0 }}
                  >
                      <XAxis
                        type="number"
                        tick={{ fontSize: 11, fill: "var(--text-muted)" }}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={(v) => `P${(v / 1000).toFixed(0)}k`}
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

            <div className="analytics-section">
              <div className="analytics-section-header">
                <h2 className="analytics-section-title">Top Items</h2>
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
                        <td className="t-right muted">{item.pct}%</td>
                      </tr>
                    ))}
                    {tableData.length === 0 && (
                      <tr><td colSpan={5} className="empty-state"><strong>No data</strong></td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="analytics-section">
              <div className="analytics-section-header">
                <h2 className="analytics-section-title">Inventory Forecast</h2>
              </div>
              {(() => {
                const items = forecast?.items ?? [];
                const sufficient = items.filter((i) => i.data_sufficient);
                const insufficient = items.filter((i) => !i.data_sufficient);
                if (items.length === 0) {
                  return (
                    <p className="muted forecast-empty">
                      No inventory data available. Stock readings and historical
                      sales are required to compute a forecast.
                    </p>
                  );
                }
                if (sufficient.length === 0) {
                  return (
                    <div className="forecast-empty">
                      <p className="muted">
                        <strong>No forecast yet.</strong> Forecasting needs roughly
                        30 days of stock readings and sales for the selected cart.
                      </p>
                      {insufficient.map((i) => (
                        <p key={i.name} className="muted small forecast-note">
                          {i.name}: {i.reason || "still collecting data"}
                        </p>
                      ))}
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
                              <td><span className={`chip ${RISK_CLASS[i.risk]}`}>{String(i.risk ?? "unknown").toUpperCase()}</span></td>
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

            {profit && <ProfitSection profit={profit} />}

            {insights.length > 0 && (
              <div className="analytics-section">
                <div className="analytics-section-header">
                  <h2 className="analytics-section-title">Data Insights</h2>
                </div>
                {insights.map((ins, idx) => (
                  <div key={idx} className={`insight-item ${ins.type}`}>
                    <div className="insight-icon"><ins.icon size={15} /></div>
                    <span className="insight-text">{ins.text}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {!trends && !error && (
          <div className="analytics-loading">
            Loading analytics...
          </div>
        )}
      </div>
    </PageErrorBoundary>
  );
}
