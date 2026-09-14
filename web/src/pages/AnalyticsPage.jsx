import { useEffect, useState, useMemo, Fragment } from "react";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis,
  Tooltip, ResponsiveContainer, CartesianGrid, Cell, LabelList,
} from "recharts";
import {
  TrendingUp, TrendingDown, ShoppingBag,
  DollarSign, BarChart2, PackageSearch, RefreshCw, X, Sparkles, Printer
} from "lucide-react";
import { useNavigate, useOutletContext } from "react-router-dom";
import api, { getErrorMessage } from "../api.js";
import Badge from "../components/Badge.jsx";
import EmptyState from "../components/EmptyState.jsx";
import { SkeletonCards, SkeletonChart } from "../components/Skeleton.jsx";
import PageErrorBoundary from "../components/PageErrorBoundary.jsx";
import PageHeader from "../components/PageHeader.jsx";
import Select from "../components/Select.jsx";
import ProfitSection from "../components/analytics/ProfitSection.jsx";
import AnalyticsTooltip, { TooltipItem } from "../components/analytics/AnalyticsTooltip.jsx";
import { fmtMoneyAxis, fmtShortDate } from "../utils/format.js";

// API risk level -> badge variant
const RISK_CHIP = { high: "danger", medium: "warn", low: "ok", unknown: "neutral" };

const HEAT_HOURS = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
const HEAT_DAYS = ["S", "M", "T", "W", "T", "F", "S"];

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
                title={`${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dow]} ${h}:00 - P${v.toLocaleString()} (${c?.orders ?? 0} orders)`}
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
    <AnalyticsTooltip label={label}>
      {payload.map((p, i) => (
        <TooltipItem key={i}>
          {p.name}: <strong className="tooltip-value">P{typeof p.value === "number" ? p.value.toLocaleString() : p.value}</strong>
        </TooltipItem>
      ))}
    </AnalyticsTooltip>
  );
}

export default function AnalyticsPage() {
  const navigate = useNavigate();
  const { user } = useOutletContext();
  const isOwner = user?.role === "OWNER";
  
  const [carts, setCarts] = useState([]);
  const [cartCode, setCartCode] = useState("");
  
  const [range, setRange] = useState("30");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");

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
  const [lastUpdated, setLastUpdated] = useState(null);
  const [summaryLang, setSummaryLang] = useState("en");

  useEffect(() => {
    api.get("/catalog").then(({ data }) => setCarts(data.locations ?? [])).catch(() => {});
  }, []);

  useEffect(() => {
    let alive = true;
    
    let dateParams = "";
    let prevDateParams = "";
    const codeParam = cartCode ? `&code=${encodeURIComponent(cartCode)}` : "";

    if (range === "custom") {
      if (!customStart || !customEnd) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- custom range guard, intentional early-exit
        setLoading(false);
        return; 
      }
      dateParams = `&startDate=${customStart}&endDate=${customEnd}`;
      
      const startD = new Date(customStart);
      const endD = new Date(customEnd);
      const diffTime = Math.abs(endD - startD);
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      
      const prevEnd = new Date(startD);
      prevEnd.setDate(prevEnd.getDate() - 1);
      const prevStart = new Date(prevEnd);
      prevStart.setDate(prevStart.getDate() - diffDays);
      
      prevDateParams = `&startDate=${prevStart.toISOString().split('T')[0]}&endDate=${prevEnd.toISOString().split('T')[0]}`;
    } else {
      const days = Number(range) || 30;
      dateParams = `&days=${days}`;
      prevDateParams = `&days=${days * 2}`;
    }

    setLoading(true);

    Promise.all([
      api.get(`/analytics/trends?1=1${dateParams}${codeParam}`),
      api.get(`/analytics/trends?1=1${prevDateParams}${codeParam}`),
      cartCode ? api.get(`/analytics/forecast?code=${encodeURIComponent(cartCode)}`).catch(() => ({ data: { code: cartCode, items: [] } })) : Promise.resolve({ data: { code: null, items: [] } }),
      // Profit is owner-only server-side: don't even request it as staff.
      // Individual .catch per auxiliary request so one slow/failed endpoint
      // degrades to its empty state instead of failing the whole page.
      isOwner ? api.get(`/analytics/profit?1=1${dateParams}${codeParam}`).catch(() => ({ data: null })) : Promise.resolve({ data: null }),
      api.get(`/analytics/hourly?1=1${dateParams}${codeParam}`).catch(() => ({ data: null })),
      api.get(`/analytics/basket?1=1${dateParams}${codeParam}`).catch(() => ({ data: null })),
      api.get(`/analytics/sales-forecast?1=1${dateParams}${codeParam}`).catch(() => ({ data: null })),
    ])
      .then(([cur, ext, f, pf, hr, bk, sf]) => {
        if (!alive) return;
        setLoading(false);

        const curSales = cur.data.total_sales;
        const extSales = ext.data.total_sales;
        const prevSales = range === "custom" ? extSales : Math.max(0, extSales - curSales);
        
        setTrends(cur.data);
        setPrevTrends({
          ...cur.data,
          total_sales: prevSales,
          orders: range === "custom" ? (ext.data.orders ?? 0) : Math.max(0, (ext.data.orders ?? 0) - (cur.data.orders ?? 0)),
        });
        
        setForecast(f.data);
        setProfit(pf.data);
        setHourly(hr.data);
        setBasket(bk.data);
        setSalesFc(sf.data);
        setError("");
        setLastUpdated(new Date());
      })
      .catch((err) => {
        if (!alive) return;
        setLoading(false);
        const msg = getErrorMessage(err, "Unable to load analytics. Please try again.");
        setError(msg);
      });

    return () => { alive = false; };
  }, [range, cartCode, reload, isOwner, customStart, customEnd]);

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

  const topItemStat = useMemo(() => {
    const cur = trends?.top_items?.[0];
    if (!cur) return { name: " ", qty: null, trend: null };

    const prevMatch = prevTrends?.top_items?.find((t) => t.name === cur.name);
    const trend =
      prevMatch && prevMatch.qty > 0
        ? ((cur.qty - prevMatch.qty) / prevMatch.qty) * 100
        : null;

    return { name: cur.name, qty: cur.qty, trend };
  }, [trends, prevTrends]);

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
        list.push({ icon: BarChart2, short: `${best.label} peaks - staff it`, href: "#section-dow", type: "info" });
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
    if (sortCol !== col) return <span className="sort-icon"> </span>;
    return <span className="sort-icon active">{sortDir === "desc" ? "↓" : "↑"}</span>;
  }

  const locationOptions = [
    { value: "", label: "All carts" },
    ...carts.map((c) => ({ value: c.code, label: `${c.code} - ${c.name}` }))
  ];

  const rangeOptions = [
    { value: "7", label: "Last 7 days" },
    { value: "14", label: "Last 14 days" },
    { value: "30", label: "Last 30 days" },
    { value: "90", label: "Last 90 days" },
    { value: "custom", label: "Custom range..." }
  ];

  const renderSmartSummary = () => {
    const rev = Number(totalRevenue).toLocaleString();
    const ord = totalOrders;
    
    const hasTrend = revenueTrend !== null;
    const isUp = revenueTrend >= 0;
    const trn = hasTrend ? Math.abs(revenueTrend).toFixed(1) : "0";
    
    const top = topItemStat?.name && topItemStat.name.trim() !== "" ? topItemStat.name : null;
    
    const pDow = hourly?.peak?.dow;
    const pHour = hourly?.peak?.hour;
    const daysEN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const daysTL = ["Linggo", "Lunes", "Martes", "Miyerkules", "Huwebes", "Biyernes", "Sabado"];
    
    const peakDayEN = pDow !== undefined ? daysEN[pDow] : null;
    const peakDayTL = pDow !== undefined ? daysTL[pDow] : null;
    
    let peakTime = null;
    if (pHour !== undefined) {
      const h = pHour > 12 ? pHour - 12 : pHour === 0 ? 12 : pHour;
      const ampm = pHour >= 12 ? 'PM' : 'AM';
      peakTime = `${h}:00 ${ampm}`;
    }

    const riskItems = forecast?.items?.filter(i => i.risk === "high" || i.risk === "medium").length || 0;
    const highlightStyle = { color: "var(--primary-strong)", fontWeight: "800", fontSize: "1.05em" };

    if (summaryLang === "en") {
      return (
        <span>
          Over the selected period, your operations generated <strong style={highlightStyle}>P{rev}</strong> across <strong style={highlightStyle}>{ord}</strong> orders
          {hasTrend ? `, marking a ${isUp ? "positive" : "negative"} trend of ` : ". "}
          {hasTrend && <strong style={{...highlightStyle, color: isUp ? "var(--success)" : "var(--danger)"}}>{trn}% {isUp ? "increase" : "decrease"}</strong>}
          {hasTrend && " from the previous period. "}
          {top && <>Your best-selling product was <strong style={highlightStyle}>{top}</strong>. </>}
          {peakDayEN && peakTime && <>Foot traffic peaked on <strong style={highlightStyle}>{peakDayEN}s around {peakTime}</strong>, so prepare your staff accordingly. </>}
          {riskItems > 0 
            ? <>Lastly, <strong style={{...highlightStyle, color: "var(--danger)"}}>{riskItems} item(s)</strong> are projected to run critically low soon and need your attention.</>
            : <>Inventory levels look healthy for now.</>}
        </span>
      );
    } else {
      return (
        <span>
          Sa napiling panahon, kumita ang iyong operasyon ng <strong style={highlightStyle}>P{rev}</strong> mula sa <strong style={highlightStyle}>{ord}</strong> na benta
          {hasTrend ? ", na may " : ". "}
          {hasTrend && <strong style={{...highlightStyle, color: isUp ? "var(--success)" : "var(--danger)"}}>{trn}% na {isUp ? "pagtaas" : "pagbaba"}</strong>}
          {hasTrend && " kumpara sa nakaraang period. "}
          {top && <>Ang pinakamabenta mong produkto ay <strong style={highlightStyle}>{top}</strong>. </>}
          {peakDayTL && peakTime && <>Inaasahan ang pinakamaraming bibili tuwing <strong style={highlightStyle}>{peakDayTL} bandang {peakTime}</strong>, kaya siguraduhing sapat ang iyong staff. </>}
          {riskItems > 0 
            ? <>Para sa imbentaryo, <strong style={{...highlightStyle, color: "var(--danger)"}}>{riskItems} na item</strong> ang malapit nang maubos at kailangan nang i-reorder agad.</>
            : <>Sa ngayon, sapat pa at ligtas ang iyong imbentaryo.</>}
        </span>
      );
    }
  };

  return (
    <PageErrorBoundary>
      <div className="page-container wide" aria-busy={loading}>
        
        <PageHeader
          eyebrow="Insights"
          title="Analytics"
          sub="Performance metrics, sales trends, and top items."
          actions={
            <div className="flex items-center gap-2 flex-wrap">
              <span className="muted small" style={{ marginRight: "4px" }}>
                Last updated {lastUpdated?.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) ?? "just now"}
              </span>
              <button
                className="ghost small-btn"
                onClick={() => {
                  setLoading(true);
                  setReload((n) => n + 1);
                }}
                disabled={loading}
                title="Refresh analytics"
              >
                <RefreshCw size={14} className={loading ? "spin" : ""} /> Refresh
              </button>
              <button
                className="small-btn"
                onClick={() => window.print()}
                title="Print Report to PDF"
              >
                <Printer size={14} /> Print Report
              </button>
            </div>
          }
        />

        <section className="panel" style={{ padding: "var(--space-4)", marginBottom: "var(--space-5)" }}>
          <div className="sales-filters-row" style={{ marginBottom: 0 }}>
            <div className="sales-filters-left">
              <Select
                value={cartCode}
                onChange={(val) => {
                  setLoading(true);
                  setCartCode(val);
                }}
                options={locationOptions}
                placeholder="All carts"
              />
              <Select
                value={range}
                onChange={(val) => {
                  setRange(val);
                  if(val !== "custom") setLoading(true);
                }}
                options={rangeOptions}
                placeholder="Select range..."
              />
              {range === "custom" && (
                <div className="flex items-center gap-2" style={{ animation: "rise-in 0.2s ease" }}>
                  <input
                    type="date"
                    value={customStart}
                    onChange={(e) => { setCustomStart(e.target.value); setLoading(true); }}
                    style={{ height: "36px", borderRadius: "14px", border: "1px solid var(--border)", padding: "0 12px", background: "var(--surface-alt)", color: "var(--text)" }}
                  />
                  <span className="muted small font-bold">to</span>
                  <input
                    type="date"
                    value={customEnd}
                    onChange={(e) => { setCustomEnd(e.target.value); setLoading(true); }}
                    style={{ height: "36px", borderRadius: "14px", border: "1px solid var(--border)", padding: "0 12px", background: "var(--surface-alt)", color: "var(--text)" }}
                  />
                </div>
              )}
            </div>
            {(cartCode || range !== "30") && (
              <button 
                className="danger-ghost small-btn" 
                onClick={() => { setCartCode(""); setRange("30"); setCustomStart(""); setCustomEnd(""); setLoading(true); }}
              >
                <X size={14} /> Clear filters
              </button>
            )}
          </div>
        </section>

        {error && (
          <div className="error-box" role="alert" style={{ marginBottom: "var(--space-4)" }}>
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
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
            
            <section 
              className="panel" 
              style={{ 
                padding: "var(--space-5) var(--space-6)", 
                background: "linear-gradient(135deg, var(--primary-soft) 0%, var(--surface) 100%)",
                border: "1px solid var(--primary-tint)",
                boxShadow: "0 12px 32px rgba(231, 54, 49, 0.12)",
                position: "relative",
                overflow: "hidden"
              }}
            >
              <Sparkles 
                size={200} 
                color="var(--primary)" 
                style={{ 
                  position: "absolute", 
                  right: "-20px", 
                  top: "-40px", 
                  opacity: 0.04, 
                  transform: "rotate(15deg)",
                  pointerEvents: "none"
                }} 
              />
              
              <div className="flex items-center justify-between" style={{ marginBottom: "var(--space-4)", position: "relative", zIndex: 10 }}>
                <h3 className="flex items-center gap-2 m-0 p-0" style={{ fontSize: 'var(--fs-xl)', fontWeight: 'var(--fw-extrabold)', color: 'var(--primary-strong)' }}>
                  <Sparkles size={22} fill="var(--primary-strong)" /> 
                  Executive Summary
                </h3>
                <div className="seg" style={{ background: "var(--surface)", padding: "4px", borderRadius: "8px", border: "1px solid var(--border)" }}>
                  <button 
                    className={`ghost small-btn ${summaryLang === "en" ? "active" : ""}`} 
                    onClick={() => setSummaryLang("en")}
                    style={{ border: "none", boxShadow: summaryLang === "en" ? "var(--shadow-sm)" : "none" }}
                  >
                    EN
                  </button>
                  <button 
                    className={`ghost small-btn ${summaryLang === "tl" ? "active" : ""}`} 
                    onClick={() => setSummaryLang("tl")}
                    style={{ border: "none", boxShadow: summaryLang === "tl" ? "var(--shadow-sm)" : "none" }}
                  >
                    TL
                  </button>
                </div>
              </div>
              
              <p style={{ margin: 0, lineHeight: 1.7, color: "var(--text)", fontSize: "var(--fs-lg)", position: "relative", zIndex: 10 }}>
                {renderSmartSummary()}
              </p>
            </section>

            <div className="analytics-kpis">
              {[
                { label: "Total Revenue", value: `P${totalRevenue.toLocaleString()}`, trend: revenueTrend, icon: DollarSign },
                { label: "Total Orders", value: totalOrders, trend: ordersTrend, icon: ShoppingBag },
                { label: "Avg Order Value", value: `P${avgOrderValue.toLocaleString()}`, trend: avgTrend, icon: BarChart2 },
                {
                  label: "Top Item",
                  value: topItemStat.name,
                  trend: topItemStat.trend,
                  sub: topItemStat.qty != null ? `${topItemStat.qty} sold` : "No data yet",
                  icon: TrendingUp,
                },
              ].map((kpi) => (
                <div key={kpi.label} className="kpi-card">
                  <div className="kpi-card-header">
                    <span className="kpi-card-label">{kpi.label}</span>
                    <div className="kpi-card-icon"><kpi.icon size={18} /></div>
                  </div>
                  <div className="kpi-card-value">{kpi.value}</div>
                  {kpi.sub && <div className="kpi-card-sub">{kpi.sub}</div>}
                  {kpi.trend !== null && kpi.trend !== undefined && (
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

            <div className="analytics-section panel" id="section-sales">
              <div className="analytics-section-header">
                <div>
                  <h2 className="analytics-section-title"><span className="section-num" aria-hidden="true">1</span> Sales Trend</h2>
                  <p className="analytics-section-sub">Daily revenue - when money comes in</p>
                </div>
              </div>
              <div
                className="chart-container"
                role="img"
                aria-label={`Area chart of daily revenue. Total revenue: P${totalRevenue.toLocaleString()}.`}
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

            <div className="analytics-section panel" id="section-dow">
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
                    {hourly.peak?.total_sales > 0 ? (
                      <>Busiest: <strong>{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][hourly.peak.dow]} {hourly.peak.hour}:00</strong> - staff the rush, prep before it.</>
                    ) : (
                      <>No hourly pattern yet - it appears once sales accumulate.</>
                    )}
                  </p>
                  <HeatmapGrid matrix={hourly.matrix} />
                  <details className="muted small" style={{ marginTop: "var(--space-2)" }}>
                    <summary>View as a table</summary>
                    <div className="table-wrap" style={{ marginTop: "var(--space-2)" }}>
                      <table className="data compact table-fixed">
                        <caption className="muted small">Revenue by weekday and hour (PHP)</caption>
                        <thead>
                          <tr>
                            <th scope="col">Day</th>
                            {HEAT_HOURS.map((h) => (
                              <th key={h} scope="col">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {[0, 1, 2, 3, 4, 5, 6].map((dow) => {
                            const byKey = new Map((hourly.matrix ?? []).map((c) => [`${c.dow}:${c.hour}`, c]));
                            return (
                              <tr key={dow}>
                                <th scope="row">{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dow]}</th>
                                {HEAT_HOURS.map((h) => (
                                  <td key={h} className="t-right">
                                    {(byKey.get(`${dow}:${h}`)?.total_sales ?? 0).toLocaleString()}
                                  </td>
                                ))}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </details>
                </div>
              )}
            </div>

            {categoryData.length > 0 && (
              <div className="analytics-section panel" id="section-category">
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

            <div className="analytics-section panel" id="section-items">
              <div className="analytics-section-header">
                <div>
                  <h2 className="analytics-section-title"><span className="section-num" aria-hidden="true">4</span> Top Items</h2>
                  <p className="analytics-section-sub">Exact products that move the needle</p>
                </div>
              </div>
              <div className="table-wrap">
                <table className="data top-items-table table-fixed">
                  <thead>
                    <tr>
                      <th style={{ width: 60 }}>#</th>
                      <th onClick={() => handleSort("name")}>Item {sortIcon("name")}</th>
                      <th onClick={() => handleSort("qty")} className="t-right" style={{ width: 120 }}>Qty Sold {sortIcon("qty")}</th>
                      <th onClick={() => handleSort("sales")} className="t-right" style={{ width: 140 }}>Revenue {sortIcon("sales")}</th>
                      <th onClick={() => handleSort("pct")} className="t-right" style={{ width: 140 }}>% of Total {sortIcon("pct")}</th>
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
                          {" "} - {p.orders} orders ({p.pct}%)
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted small">Single-item tickets so far - no pairs to show yet.</p>
                  )}
                </div>
              )}
            </div>

            <div className="analytics-section panel" id="section-forecast">
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
                      <table className="data table-fixed">
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
                              <td>{i.depletion_date ?? "-"}</td>
                              <td className="muted">{i.mape_pct != null ? `${i.mape_pct}%` : "-"}</td>
                              <td><Badge variant={RISK_CHIP[i.risk] ?? "neutral"}>{String(i.risk ?? "unknown").toUpperCase()}</Badge></td>
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

            <div className="analytics-section panel" id="section-revenue-fc">
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
                    {salesFc.mape != null && <> - backtest MAPE <strong>{salesFc.mape}%</strong></>}.
                    {" "}<span aria-hidden="true">-</span> dashed line = forecast, not history.
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
                    : "Collecting sales history..."}
                </p>
              )}
            </div>

            {isOwner && profit && <ProfitSection profit={profit} />}
          </div>
        )}

        {loading && !trends && (
          <div className="analytics-loading" role="status" aria-label="Loading analytics">
            <SkeletonCards count={3} />
            <div style={{ marginTop: "var(--space-4)" }}>
              <SkeletonChart />
            </div>
            <span className="muted small">Loading analytics...</span>
          </div>
        )}
      </div>
    </PageErrorBoundary>
  );
}