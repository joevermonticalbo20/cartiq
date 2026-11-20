import { useEffect, useState, useMemo, Fragment } from "react";
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis,
  Tooltip, ResponsiveContainer, CartesianGrid, LabelList,
} from "recharts";
import {
  TrendingUp, TrendingDown, ShoppingBag,
  DollarSign, BarChart2, PackageSearch, X, Sparkles, Printer
} from "lucide-react";
import { useNavigate, useOutletContext } from "react-router-dom";
import api from "../api.js";
import { getFriendlyError } from "../utils/errors.js";
import { addCartBreakdowns } from "../utils/analytics.js";
import { useLiveList } from "../state/liveData.js";
import Badge from "../components/Badge.jsx";
import EmptyState from "../components/EmptyState.jsx";
import { SkeletonCards, TableSkeleton } from "../components/Skeleton.jsx";
import PageErrorBoundary from "../components/PageErrorBoundary.jsx";
import PageHeader from "../components/PageHeader.jsx";
import Select from "../components/Select.jsx";
import ProfitSection from "../components/analytics/ProfitSection.jsx";
import AnalyticsTooltip, { TooltipItem } from "../components/analytics/AnalyticsTooltip.jsx";
import { fmtMoneyAxis, fmtShortDate } from "../utils/format.js";

// Exact colors matching the CartIQ theme system variables
const CHART_COLORS = [
  "var(--primary)",           // Base Brand Red
  "#F87171",                  // Light Red-Orange
  "var(--primary-strong)",    // Darker Brand Red
  "#FCA5A5",                  // Soft Light Red
  "#991B1B",                  // Deep Dark Red
  "#FECACA",                  // Pale Red
  "#7F1D1D"                   // Very Dark Red
];
const BUSIEST_DAYS_STACK_COLORS = [
  "#C2410C",
  "#E73631",
  "#F97316",
  "#B91C1C",
  "#FB6A4A",
  "#9A3412",
  "#FDBA74",
];
// API risk level -> badge variant
const RISK_CHIP = { high: "danger", medium: "warn", low: "ok", unknown: "neutral" };

function mapeBadge(value) {
  if (value == null || Number.isNaN(Number(value))) return { label: "No backtest", variant: "neutral" };
  const n = Number(value);
  if (n < 20) return { label: `High confidence (${n}%)`, variant: "ok" };
  if (n <= 50) return { label: `Directional (${n}%)`, variant: "warn" };
  return { label: `Demonstration only (${n}%)`, variant: "danger" };
}

const HEAT_HOURS = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
const HEAT_DAYS = ["S", "M", "T", "W", "T", "F", "S"];

function formatHour12(h) {
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour} ${ampm}`;
}

function HeatmapGrid({ matrix }) {
  const byKey = new Map((matrix ?? []).map((c) => [`${c.dow}:${c.hour}`, c]));
  const max = Math.max(1, ...(matrix ?? []).map((c) => c.total_sales));

  return (
    <div className="heat-grid" role="img" aria-label="Heatmap of revenue by weekday and hour">
      <div className="heat-corner" />
      {HEAT_HOURS.map((h) => (
        <span key={h} className="heat-col-label">{formatHour12(h)}</span>
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
                title={`${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dow]} ${formatHour12(h)} - P${v.toLocaleString()} (${c?.orders ?? 0} orders)`}
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
          {p.name === "total_sales" || p.name === "expected_use" ? "Total" : p.name}: <strong className="tooltip-value">P{typeof p.value === "number" ? p.value.toLocaleString() : p.value}</strong>
        </TooltipItem>
      ))}
    </AnalyticsTooltip>
  );
}

function previousWindow(startDate, endDate) {
  const start = parseIsoDate(startDate);
  const end = parseIsoDate(endDate);
  if (!start || !end) return null;
  const spanDays = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
  const prevEnd = new Date(start.getTime() - 86400000);
  const prevStart = new Date(prevEnd.getTime() - (spanDays - 1) * 86400000);
  return {
    startDate: toIsoDate(prevStart),
    endDate: toIsoDate(prevEnd),
  };
}

function parseIsoDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ""));
  if (!m) return null;
  const [year, month, day] = m.slice(1).map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    !Number.isFinite(d.getTime()) ||
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) return null;
  return d;
}

function toIsoDate(d) {
  return d.toISOString().slice(0, 10);
}

function getAnalyticsDateWindow(range, startDate, endDate, now = new Date()) {
  let start;
  let end;
  if (range === "custom") {
    start = parseIsoDate(startDate);
    end = parseIsoDate(endDate);
    if (!start || !end || start > end) return null;
  } else {
    const days = Math.min(90, Math.max(1, Number(range) || 30));
    const todayParts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Manila",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(now).map(({ type, value }) => [type, value])
    );
    end = parseIsoDate(`${todayParts.year}-${todayParts.month}-${todayParts.day}`);
    start = new Date(end.getTime() - (days - 1) * 86400000);
  }

  const previous = previousWindow(toIsoDate(start), toIsoDate(end));
  if (!previous) return null;
  return {
    startDate: toIsoDate(start),
    endDate: toIsoDate(end),
    previousStartDate: previous.startDate,
    previousEndDate: previous.endDate,
  };
}

function analyticsQuery(dateWindow, code) {
  const params = new URLSearchParams({
    startDate: dateWindow.startDate,
    endDate: dateWindow.endDate,
  });
  if (code) params.set("code", code);
  return params.toString();
}

export default function AnalyticsPage() {
  const navigate = useNavigate();
  const { user } = useOutletContext();
  const isOwner = user?.role === "OWNER";
  const { data: cartList, error: cartsError } = useLiveList("carts");
  const carts = useMemo(() => Array.isArray(cartList) ? cartList : [], [cartList]);
  
  const [cartCode, setCartCode] = useState("");
  const [range, setRange] = useState("30");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const [trends, setTrends] = useState(null);
  const [prevTrends, setPrevTrends] = useState(null);
  const [forecast, setForecast] = useState(null);
  const [profit, setProfit] = useState(null);
  const [hourly, setHourly] = useState(null);
  const [salesFc, setSalesFc] = useState(null);
  // Per-cart expected-sales forecasts, for the All-carts comparison.
  const [salesFcCarts, setSalesFcCarts] = useState([]);

  const [error, setError] = useState("");
  const [sectionErrors, setSectionErrors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);

  const [sortCol, setSortCol] = useState("sales");
  const [sortDir, setSortDir] = useState("desc");
  const [summaryLang, setSummaryLang] = useState("en");

  // State for interactive Pie Chart
  const [selectedCategory, setSelectedCategory] = useState(null);

  const scrollToSection = (id) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' });
    }
  };

  useEffect(() => {
    let alive = true;
    const dateWindow = getAnalyticsDateWindow(range, startDate, endDate);
    if (!dateWindow) {
      const timer = setTimeout(() => {
        if (!alive) return;
        setLoading(false);
        setError(range === "custom" && startDate && endDate
          ? "Enter a valid date range with the start on or before the end."
          : "");
      }, 0);
      return () => {
        alive = false;
        clearTimeout(timer);
      };
    }

    const currentQuery = analyticsQuery(dateWindow, cartCode);
    const previousQuery = analyticsQuery({
      startDate: dateWindow.previousStartDate,
      endDate: dateWindow.previousEndDate,
    }, cartCode);
    const currentTrendsRequest = api.get(`/analytics/trends?${currentQuery}`);
    const previousTrendsRequest = api.get(`/analytics/trends?${previousQuery}`);
    const optionalRequest = (request) => request
      .then(({ data }) => ({ data }))
      .catch((requestError) => ({ data: null, error: requestError }));
    const hourlyRequest = optionalRequest(api.get(`/analytics/hourly?${currentQuery}`));
    const salesForecastRequest = optionalRequest(api.get(`/analytics/sales-forecast?${currentQuery}`));
    // The chart needs each cart's own expected series so the All-carts view can
    // compare carts instead of showing one aggregate line.
    const salesForecastCartsRequest = !cartCode
      ? Promise.all(
          carts
            .filter((cart) => cart.status !== "INACTIVE")
            .map(async (cart) => {
              try {
                const query = analyticsQuery(dateWindow, cart.code);
                const { data } = await api.get(`/analytics/sales-forecast?${query}`);
                return { code: cart.code, data };
              } catch (requestError) {
                return { code: cart.code, error: requestError };
              }
            })
        )
      : Promise.resolve([]);
    const profitRequest = isOwner
      ? optionalRequest(api.get(`/analytics/profit?${currentQuery}`))
      : Promise.resolve({ data: null });
    const trendCarts = cartCode ? [] : carts;
    const cartTrendsRequest = Promise.all(trendCarts.map(async (cart) => {
      try {
        const query = analyticsQuery(dateWindow, cart.code);
        const { data } = await api.get(`/analytics/trends?${query}`);
        if (data.location !== cart.code) {
          throw new Error(`Cart "${cart.code}" was not found.`);
        }
        return { code: cart.code, data };
      } catch (requestError) {
        return { code: cart.code, error: requestError };
      }
    }));
    const forecastCarts = cartCode
      ? [{ code: cartCode }]
      : carts.filter((cart) => cart.status !== "INACTIVE");
    const forecastsRequest = Promise.all(forecastCarts.map(async (cart) => {
      try {
        const { data } = await api.get(`/analytics/forecast?code=${encodeURIComponent(cart.code)}`);
        return { code: cart.code, data };
      } catch (requestError) {
        return { code: cart.code, error: requestError };
      }
    }));

    Promise.all([
      currentTrendsRequest,
      previousTrendsRequest,
      hourlyRequest,
      salesForecastRequest,
      salesForecastCartsRequest,
      profitRequest,
      cartTrendsRequest,
      forecastsRequest,
    ]).then(([currentResponse, previousResponse, hourlyResult, salesForecastResult, salesForecastCartResults, profitResult, cartTrendResults, forecastResults]) => {
      if (!alive) return;
      setLoading(false);
      const currentData = currentResponse.data;
      const previousData = previousResponse.data;
      if (cartCode && (
        currentData.location !== cartCode || previousData.location !== cartCode
      )) {
        throw new Error(`Cart "${cartCode}" was not found.`);
      }
      const cartTrendFailures = cartTrendResults.some((result) => result.error);
      const successfulCartTrends = cartTrendFailures ? [] : cartTrendResults;
      const failedForecast = forecastResults.some((result) => result.error);
      const forecastData = {
        items: forecastResults.flatMap(({ code, data }) =>
          (data?.items ?? []).map((item) => ({ ...item, cart_code: code }))
        ),
        event_days_excluded: [...new Set(forecastResults.flatMap(
          ({ data }) => data?.event_days_excluded ?? []
        ))],
      };
      const failedSections = [];
      if (cartsError) failedSections.push("Cart list");
      if (cartTrendFailures) failedSections.push("Cart breakdown");
      if (hourlyResult.error) failedSections.push("Hourly traffic");
      if (salesForecastResult.error) failedSections.push("Sales forecast");
      if (profitResult.error) failedSections.push("Profit");
      if (failedForecast) failedSections.push("Stock forecast");

      setTrends(addCartBreakdowns(currentData, successfulCartTrends));
      setPrevTrends({
        total_sales: previousData.total_sales ?? 0,
        orders: previousData.orders ?? 0,
        top_items: [],
      });
      setForecast(failedForecast || forecastCarts.length === 0 ? null : forecastData);
      setProfit(profitResult.data);
      setHourly(hourlyResult.data);
      setSalesFc(salesForecastResult.data);
      setSalesFcCarts(salesForecastCartResults.filter((result) => !result.error));
      setSectionErrors(failedSections);
      setError("");
    }).catch((requestError) => {
      if (!alive) return;
      setLoading(false);
      setTrends(null);
      setPrevTrends(null);
      setForecast(null);
      setProfit(null);
      setHourly(null);
      setSalesFc(null);
      setSalesFcCarts([]);
      setSectionErrors([]);
      setError(getFriendlyError(requestError, "Unable to load analytics. Please try again."));
    });

    return () => {
      alive = false;
    };
  }, [range, cartCode, reload, isOwner, startDate, endDate, carts, cartsError]);

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

  const categoryData = useMemo(() => {
    const items = trends?.top_items ?? [];
    const byCategory = {};
    for (const item of items) {
      const cat = item.name?.split(" ")[0] ?? "Other";
      if (!byCategory[cat]) byCategory[cat] = 0;
      byCategory[cat] += Number(item.sales) || 0;
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

  function dowCellFill(entry, index) {
    if (entry.total_sales <= 0) return "var(--border)";
    return BUSIEST_DAYS_STACK_COLORS[index % BUSIEST_DAYS_STACK_COLORS.length];
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

  const filteredTopItems = useMemo(() => {
    if (!selectedCategory) return tableData;
    return tableData.filter(item => {
      const cat = item.name?.split(" ")[0] ?? "Other";
      return cat === selectedCategory;
    });
  }, [tableData, selectedCategory]);

  function handleSort(col) {
    if (sortCol === col) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else { setSortCol(col); setSortDir("desc"); }
  }

  function sortIcon(col) {
    if (sortCol !== col) return <span className="sort-icon">▲</span>;
    return <span className="sort-icon active">{sortDir === "desc" ? "▼" : "▲"}</span>;
  }

  const activeInventory = carts;
  
  const dailySeriesData = trends?.daily_series || [];
  const hasCartBreakdown_Daily = !cartCode && activeInventory.some((loc) => 
    dailySeriesData.some((d) => d[loc.code] !== undefined)
  );

  const hasCartBreakdown_Weekly = !cartCode && activeInventory.some((loc) => 
    dowData.some((d) => d[loc.code] !== undefined)
  );

  const forecastHorizon = Number(salesFc?.horizon_days) || 7;
  const isFcReady = salesFc && salesFc.data_sufficient && salesFc.forecast?.length > 0;

  // One row per cart for the All-carts comparison: expected total for the next
  // horizon, matched against the last horizon days of actuals.
  const forecastCartRows = useMemo(() => {
    if (cartCode) return [];
    return salesFcCarts
      .map(({ code, data }) => ({
        code,
        sufficient: Boolean(data?.data_sufficient),
        total: (data?.forecast ?? []).reduce(
          (sum, row) => sum + (Number(row.expected_use) || 0),
          0
        ),
      }))
      .filter((row) => row.sufficient);
  }, [salesFcCarts, cartCode]);

  // Merge the per-cart expected series onto the aggregate dates so the chart can
  // draw one dashed line per cart.
  const forecastSeriesData = useMemo(() => {
    if (!isFcReady) return [];
    const byDate = new Map();
    for (const row of salesFc.forecast) {
      byDate.set(row.date, { date: row.date, expected_use: row.expected_use });
    }
    for (const { code, data } of salesFcCarts) {
      if (!data?.data_sufficient) continue;
      for (const row of data.forecast ?? []) {
        const entry = byDate.get(row.date) ?? { date: row.date };
        entry[code] = row.expected_use;
        byDate.set(row.date, entry);
      }
    }
    return [...byDate.values()];
  }, [isFcReady, salesFc, salesFcCarts]);

  const hasCartBreakdown_Forecast = !cartCode && forecastCartRows.length > 0;

  const totalExpectedSales = useMemo(() => {
    if (!isFcReady) return 0;
    return salesFc.forecast.reduce((sum, item) => sum + (Number(item.expected_use) || 0), 0);
  }, [isFcReady, salesFc]);

  // Actual revenue for the same length of time immediately before the forecast,
  // per cart and in total. This keeps "vs past" apples-to-apples.
  const pastWindowByCart = useMemo(() => {
    const series = trends?.daily_series ?? [];
    const window = series.slice(-Math.min(forecastHorizon, series.length));
    const map = {};
    for (const cart of activeInventory) {
      map[cart.code] = window.reduce(
        (sum, day) => sum + (Number(day[cart.code]) || 0),
        0
      );
    }
    return map;
  }, [trends, activeInventory, forecastHorizon]);

  const pastWindowTotal = useMemo(
    () =>
      (trends?.daily_series ?? [])
        .slice(-Math.min(forecastHorizon, (trends?.daily_series ?? []).length))
        .reduce((sum, day) => sum + (Number(day.total_sales) || 0), 0),
    [trends, forecastHorizon]
  );

  const comparisonForecastTotal = forecastCartRows.length > 0
    ? forecastCartRows.reduce((sum, row) => sum + row.total, 0)
    : totalExpectedSales;
  const expectedVariance = comparisonForecastTotal - pastWindowTotal;
  const expectedVariancePct = pastWindowTotal > 0
    ? (expectedVariance / pastWindowTotal) * 100
    : null;
  const isVarianceUp = expectedVariance >= 0;

  const locationOptions = [
    { value: "", label: "All carts" },
    ...carts.map((c) => ({
      value: c.code,
      label: `${c.code} - ${c.name}${c.status === "INACTIVE" ? " (inactive)" : ""}`,
    }))
  ];

  const rangeOptions = [
    { value: "7", label: "Last 7 days" },
    { value: "14", label: "Last 14 days" },
    { value: "30", label: "Last 30 days" },
    { value: "90", label: "Last 90 days" },
    { value: "custom", label: "Custom Date Range" }
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
      peakTime = formatHour12(pHour);
    }
    
    const riskItems = forecast?.items?.filter(i => i.risk === "high" || i.risk === "medium").length || 0;
    const forecastFailed = sectionErrors.includes("Stock forecast") ||
      forecast === null || forecast.items.length === 0;

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
            : forecastFailed
            ? <>The stock forecast could not be loaded, so low-stock risk is unknown for now.</>
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
            : forecastFailed
            ? <>Hindi na-load ang stock forecast, kaya hindi pa alam ang antas ng panganib ng stock ngayon.</>
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
                  setLoading(true);
                }}
                options={rangeOptions}
                placeholder="Select range..."
              />
              {range === "custom" && (
                <div className="flex gap-2 items-center" style={{ animation: "rise-in 0.2s ease" }}>
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => {
                      setStartDate(e.target.value);
                      setLoading(true);
                    }}
                    style={{ height: '48px', borderRadius: 'var(--radius)', border: '1px solid var(--border)', padding: '0 12px', background: 'var(--surface-alt)', color: 'var(--text)' }}
                  />
                  <span className="muted">to</span>
                  <input
                    type="date"
                    value={endDate}
                    onChange={(e) => {
                      setEndDate(e.target.value);
                      setLoading(true);
                    }}
                    style={{ height: '48px', borderRadius: 'var(--radius)', border: '1px solid var(--border)', padding: '0 12px', background: 'var(--surface-alt)', color: 'var(--text)' }}
                  />
                  <button 
                    className="small-btn"
                    onClick={() => { setReload(n => n + 1); setLoading(true); }}
                    disabled={!startDate || !endDate}
                  >
                    Apply
                  </button>
                </div>
              )}
            </div>
            
            {(cartCode || range !== "30" || startDate || endDate) && (
              <button
                className="danger-ghost small-btn"
                onClick={() => { 
                  setCartCode("");
                  setRange("30");
                  setStartDate("");
                  setEndDate("");
                  setReload(n => n + 1); 
                  setLoading(true); 
                }}
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

        {sectionErrors.length > 0 && !loading && (
          <div className="error-box" role="status" style={{ marginBottom: "var(--space-4)" }}>
            Could not load: {sectionErrors.join(", ")}. The rest of the page is
            up to date.
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
                  Quick Summary
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
                { label: "Total Income", value: `P${totalRevenue.toLocaleString()}`, trend: revenueTrend, icon: DollarSign, targetId: "section-sales" },
                { label: "Total Orders", value: totalOrders, trend: ordersTrend, icon: ShoppingBag, targetId: "section-dow" },
                { label: "Average Spend per Customer", value: `P${avgOrderValue.toLocaleString()}`, trend: avgTrend, icon: BarChart2, targetId: "section-sales-breakdown" },
                {
                  label: "Top Item",
                  value: topItemStat.name,
                  trend: topItemStat.trend,
                  sub: topItemStat.qty != null ? `${topItemStat.qty} sold` : "No data yet",
                  icon: TrendingUp,
                  targetId: "section-sales-breakdown"
                },
              ].map((kpi) => (
                <div 
                  key={kpi.label} 
                  className="kpi-card"
                  onClick={() => scrollToSection(kpi.targetId)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      scrollToSection(kpi.targetId);
                    }
                  }}
                  style={{ cursor: "pointer" }}
                  title={`Go to ${kpi.label} section`}
                >
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

            <div className="analytics-section panel" id="section-sales">
              <div className="analytics-section-header">
                <div>
                  <h2 className="analytics-section-title"><span className="section-num" aria-hidden="true">1</span> Sales Trend</h2>
                  <p className="analytics-section-sub">Daily revenue - when money comes in</p>
                </div>
              </div>
              
              {(() => {
                const hasSalesData = dailySeriesData.length > 0 && trends?.total_sales > 0;
                const displayData = hasSalesData ? dailySeriesData : [
                  { date: "Mon", total_sales: 0 }, { date: "Tue", total_sales: 0 }, { date: "Wed", total_sales: 0 },
                  { date: "Thu", total_sales: 0 }, { date: "Fri", total_sales: 0 }, { date: "Sat", total_sales: 0 }, { date: "Sun", total_sales: 0 }
                ];
                return (
                  <div style={{ position: "relative" }}>
                    {!hasSalesData && (
                      <div style={{ position: "absolute", inset: 0, zIndex: 10, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <span className="muted" style={{ fontWeight: 600, fontSize: "var(--fs-sm)", background: "var(--surface)", padding: "4px 12px", borderRadius: "99px", border: "1px solid var(--border)" }}>
                          No sales data yet
                        </span>
                      </div>
                    )}
                    <div
                      className="chart-container"
                      role="img"
                      aria-label={`Area chart of daily revenue. Total revenue: P${totalRevenue.toLocaleString()}.`}
                      style={{ opacity: hasSalesData ? 1 : 0.4, pointerEvents: hasSalesData ? "auto" : "none" }}
                    >
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={displayData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
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
                            tickFormatter={hasSalesData ? fmtShortDate : undefined}
                          />
                          <YAxis
                            tick={{ fontSize: 11, fill: "var(--text-muted)" }}
                            tickLine={false}
                            axisLine={false}
                            tickFormatter={fmtMoneyAxis}
                            width={52}
                            domain={hasSalesData ? [0, 'auto'] : [0, 1000]}
                          />
                          <Tooltip content={hasSalesData ? <CustomTooltip /> : null} />
                          
                          {hasCartBreakdown_Daily ? (
                            activeInventory.map((loc, idx) => (
                              <Area
                                key={loc.code}
                                type="monotone"
                                dataKey={loc.code}
                                name={loc.code}
                                stackId="1"
                                stroke={CHART_COLORS[idx % CHART_COLORS.length]}
                                fill={CHART_COLORS[idx % CHART_COLORS.length]}
                                fillOpacity={0.6}
                                dot={false}
                                activeDot={{ r: 4, fill: CHART_COLORS[idx % CHART_COLORS.length] }}
                              />
                            ))
                          ) : (
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
                          )}
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                );
              })()}
            </div>

            <div className="analytics-section panel" id="section-dow">
              <div className="analytics-section-header">
                <div>
                  <h2 className="analytics-section-title"><span className="section-num" aria-hidden="true">2</span> Busiest Days</h2>
                  <p className="analytics-section-sub">See which days bring in the most sales</p>
                </div>
              </div>
              
              {(() => {
                const hasDowData = dowData.some(d => d.total_sales > 0);
                const displayData = hasDowData ? dowData : [
                  { label: "Mon", total_sales: 0 }, { label: "Tue", total_sales: 0 }, { label: "Wed", total_sales: 0 },
                  { label: "Thu", total_sales: 0 }, { label: "Fri", total_sales: 0 }, { label: "Sat", total_sales: 0 }, { label: "Sun", total_sales: 0 }
                ];
                return (
                  <div style={{ position: "relative" }}>
                    {!hasDowData && (
                      <div style={{ position: "absolute", inset: 0, zIndex: 10, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <span className="muted" style={{ fontWeight: 600, fontSize: "var(--fs-sm)", background: "var(--surface)", padding: "4px 12px", borderRadius: "99px", border: "1px solid var(--border)" }}>
                          No weekly trends yet
                        </span>
                      </div>
                    )}
                    <div
                      className="chart-container"
                      role="img"
                      aria-label={`Bar chart of revenue by day of week. Best day: ${
                        dowData.find((d) => d.total_sales === maxDow)?.label ?? "n/a"
                      } with P${maxDow.toLocaleString()}.`}
                      style={{ opacity: hasDowData ? 1 : 0.4, pointerEvents: hasDowData ? "auto" : "none" }}
                    >
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={displayData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }} maxBarSize={48}>
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
                            domain={hasDowData ? [0, 'auto'] : [0, 1000]}
                          />
                          <Tooltip content={hasDowData ? <CustomTooltip /> : null} />
                          
                          {hasCartBreakdown_Weekly ? (
                            activeInventory.map((loc, idx) => (
                              <Bar 
                                key={loc.code} 
                                dataKey={loc.code} 
                                name={loc.code}
                                stackId="a" 
                                fill={BUSIEST_DAYS_STACK_COLORS[idx % BUSIEST_DAYS_STACK_COLORS.length]}
                                stroke="var(--surface)"
                                strokeWidth={1}
                                radius={idx === activeInventory.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]}
                              />
                            ))
                          ) : (
                            <Bar
                              dataKey="total_sales"
                              name="Revenue"
                              radius={[4, 4, 0, 0]}
                            >
                              {displayData.map((entry, index) => (
                                <Cell key={`cell-${index}`} fill={hasDowData ? dowCellFill(entry, index) : "var(--primary-soft)"} />
                              ))}
                              <LabelList
                                dataKey="total_sales"
                                position="top"
                                formatter={(v) => (v === maxDow && v > 0 ? fmtMoneyAxis(v) : "")}
                                style={{ fontSize: 10, fill: "var(--text-muted)", fontWeight: 600 }}
                              />
                            </Bar>
                          )}
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                );
              })()}
              
              {hourly && (
                <div style={{ marginTop: "var(--space-5)" }}>
                  <h3 className="profit-chart-title">Peak hours</h3>
                  <p className="muted small" style={{ marginBottom: "var(--space-2)" }}>
                    {hourly.peak?.total_sales > 0 ? (
                      <>Busiest: <strong>{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][hourly.peak.dow]} {formatHour12(hourly.peak.hour)}</strong> - staff the rush, prep before it.</>
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
                              <th key={h} scope="col">{formatHour12(h)}</th>
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

            {/* COMBINED SECTION: SALES BY CATEGORY & TOP ITEMS */}
            <div className="analytics-section panel" id="section-sales-breakdown">
              <div className="analytics-section-header">
                <div>
                  <h2 className="analytics-section-title"><span className="section-num" aria-hidden="true">3</span> Sales Breakdown</h2>
                  <p className="analytics-section-sub">Sales by Category & Top Items</p>
                </div>
                {selectedCategory && (
                  <button className="small-btn ghost" onClick={() => setSelectedCategory(null)}>
                    <X size={14} /> Clear Filter
                  </button>
                )}
              </div>

              {tableData.length === 0 ? (
                <EmptyState
                  icon={PackageSearch}
                  title="No top items yet"
                  subtitle="Sales data will appear here once orders are processed."
                  compact
                />
              ) : (
                <div className="dashboard-ops-row" style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr", gap: "var(--space-4)", alignItems: "start" }}>
                  
                  {/* LEFT: INTERACTIVE PIE CHART */}
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                    <h4 className="muted small text-center" style={{ marginBottom: "8px", fontWeight: 700 }}>
                      {selectedCategory ? `Viewing: ${selectedCategory}` : "Click a category slice to filter"}
                    </h4>
                    <div className="chart-container" style={{ height: "260px", width: "100%" }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={categoryData}
                            dataKey="sales"
                            nameKey="name"
                            cx="50%"
                            cy="50%"
                            innerRadius={55}
                            outerRadius={95}
                            paddingAngle={2}
                            onClick={(data) => setSelectedCategory(data.name === selectedCategory ? null : data.name)}
                            style={{ cursor: "pointer", outline: "none" }}
                          >
                            {categoryData.map((entry, index) => (
                              <Cell 
                                key={`cell-${index}`} 
                                fill={CHART_COLORS[index % CHART_COLORS.length]} 
                                opacity={selectedCategory && selectedCategory !== entry.name ? 0.3 : 1}
                                stroke={selectedCategory === entry.name ? "var(--surface)" : "none"}
                                strokeWidth={3}
                                style={{ outline: "none" }}
                              />
                            ))}
                          </Pie>
                          <Tooltip 
                            contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "8px", fontSize: "12px", fontWeight: 600, color: "var(--text)" }}
                            itemStyle={{ color: "var(--text)" }}
                            formatter={(value, name, props) => [`P${Number(value).toLocaleString()} (${props.payload.pct}%)`, name]}
                          />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  {/* RIGHT: DYNAMIC TOP ITEMS TABLE */}
                  <div className="table-wrap" style={{ height: "290px", overflowY: "auto", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)" }}>
                    <table className="data top-items-table table-fixed">
                      <thead style={{ position: "sticky", top: 0, zIndex: 10, background: "var(--surface-alt)" }}>
                        <tr>
                          <th style={{ width: 40 }}>#</th>
                          <th onClick={() => handleSort("name")}>Item {sortIcon("name")}</th>
                          <th onClick={() => handleSort("qty")} className="t-right" style={{ width: 90 }}>Qty {sortIcon("qty")}</th>
                          <th onClick={() => handleSort("sales")} className="t-right" style={{ width: 110 }}>Revenue {sortIcon("sales")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredTopItems.length === 0 ? (
                          <tr>
                            <td colSpan={4} className="text-center muted py-4">No items found for this category.</td>
                          </tr>
                        ) : (
                          filteredTopItems.map((item, idx) => (
                            <tr key={item.rank}>
                              <td className="muted">{idx + 1}</td>
                              <td>
                                <strong>{item.name}</strong>
                                {item.flavor && <span className="muted flavor-note">({item.flavor})</span>}
                              </td>
                              <td className="t-right">{item.qty}</td>
                              <td className="t-right">P{Number(item.sales).toLocaleString()}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            <div className="analytics-section panel" id="section-forecast">
              <div className="analytics-section-header">
                <div>
                  <h2 className="analytics-section-title"><span className="section-num" aria-hidden="true">4</span> Stock Predictions</h2>
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
                            <li key={`${i.cart_code}-${i.name}`} className="muted small">
                              {i.name} ({i.cart_code}): {i.reason || "still collecting data"}
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
                    <div className="table-wrap" style={{ height: "300px", overflowY: "auto" }}>
                      <table className="data table-fixed">
                        <thead>
                          <tr>
                            <th>Item</th>
                            <th>Stock</th>
                            <th>Avg/day</th>
                            <th>Depletion</th>
                            <th title="Confidence is derived from the backtest sMAPE: under 20% = high confidence, 20-50% = directional, over 50% = demonstration only">Forecast confidence</th>
                            <th>Risk</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sufficient.map((i) => (
                            <tr key={`${i.cart_code}-${i.name}`}>
                              <td>
                                <strong>{i.name}</strong>
                                <span className="muted small"> · {i.cart_code}</span>
                              </td>
                              <td>{i.current_stock} {i.unit}</td>
                              <td>{i.avg_daily_use} {i.unit}</td>
                              <td>{i.depletion_date ?? "-"}</td>
                              <td>{i.mape_pct != null ? <Badge variant={mapeBadge(i.mape_pct).variant}>{mapeBadge(i.mape_pct).label}</Badge> : <span className="muted">-</span>}</td>
                              <td><Badge variant={RISK_CHIP[i.risk] ?? "neutral"}>{String(i.risk ?? "unknown").toUpperCase()}</Badge></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="muted small forecast-note" style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", margin: 0 }}>
                      <span>Confidence from the backtest sMAPE:</span>
                      <Badge variant="ok">below 20%</Badge>
                      <Badge variant="warn">20–50% directional</Badge>
                      <Badge variant="danger">above 50% demonstration only</Badge>
                      {Array.isArray(forecast?.event_days_excluded) && forecast.event_days_excluded.length > 0 && (
                        <span> • excludes {forecast.event_days_excluded.length} marked event day(s)</span>
                      )}
                    </p>
                    {insufficient.length > 0 && (
                      <details className="forecast-note">
                        <summary className="muted small" style={{ cursor: "pointer" }}>
                          {insufficient.length} item(s) not yet forecastable
                        </summary>
                        <ul style={{ margin: "var(--space-2) 0 0 0", paddingLeft: "var(--space-5)" }}>
                          {insufficient.map((i) => (
                            <li key={`${i.cart_code}-${i.name}`} className="muted small">
                              {i.name} ({i.cart_code}): {i.reason || "still collecting data"}
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
                  <h2 className="analytics-section-title"><span className="section-num" aria-hidden="true">5</span> Expected Sales</h2>
                  <p className="analytics-section-sub">Expected daily revenue, next {salesFc?.horizon_days ?? 7} days{!cartCode ? " · per cart" : ""}</p>
                </div>
                
                {/* EXPECTED SALES VARIANCE CALCULATOR (Displayed only when All Carts is active) */}
                {!cartCode && isFcReady && (
                  <div style={{ textAlign: "right", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px" }}>
                    <div style={{ fontSize: "var(--fs-lg)", fontWeight: "var(--fw-extrabold)", color: "var(--text)", lineHeight: 1 }}>
                      P{Math.round(comparisonForecastTotal).toLocaleString()}
                    </div>
                    {expectedVariancePct != null && (
                      <Badge variant={isVarianceUp ? "ok" : "warn"}>
                        {isVarianceUp ? "+" : ""}P{Math.abs(Math.round(expectedVariance)).toLocaleString()} ({isVarianceUp ? "+" : ""}{expectedVariancePct.toFixed(1)}%) vs prev {forecastHorizon}d
                      </Badge>
                    )}
                    <span className="muted small">
                      Prev {forecastHorizon}d actual: P{Math.round(pastWindowTotal).toLocaleString()}
                    </span>
                  </div>
                )}
              </div>
              
              {(() => {
                const displayData = isFcReady ? forecastSeriesData : [
                  { date: "Day 1", expected_use: 0 }, { date: "Day 2", expected_use: 0 }, { date: "Day 3", expected_use: 0 },
                  { date: "Day 4", expected_use: 0 }, { date: "Day 5", expected_use: 0 }, { date: "Day 6", expected_use: 0 }, { date: "Day 7", expected_use: 0 }
                ];
                return (
                  <div style={{ position: "relative" }}>
                    {!isFcReady && (
                      <div style={{ position: "absolute", inset: 0, zIndex: 10, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <span className="muted" style={{ fontWeight: 600, fontSize: "var(--fs-sm)", background: "var(--surface)", padding: "4px 12px", borderRadius: "99px", border: "1px solid var(--border)" }}>
                          {salesFc && !salesFc.data_sufficient
                            ? `Forecast activates after 14 days of sales${salesFc.reason ? ` (${salesFc.reason})` : ""}.`
                            : "Collecting sales history..."}
                        </span>
                      </div>
                    )}
                    
                    <p className="muted small" style={{ marginBottom: "var(--space-2)", opacity: isFcReady ? 1 : 0.5, display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}>
                      <span>Same engine as inventory forecasts</span>
                      {isFcReady && salesFc.mape != null && <Badge variant={mapeBadge(salesFc.mape).variant}>{mapeBadge(salesFc.mape).label}</Badge>}
                      {Array.isArray(salesFc?.event_days_excluded) && salesFc.event_days_excluded.length > 0 && (
                        <span> • excludes {salesFc.event_days_excluded.length} marked event day(s)</span>
                      )}
                      <span aria-hidden="true">-</span>
                      <span>{hasCartBreakdown_Forecast ? "shaded areas = forecast, not history" : "dashed line = forecast, not history"}.</span>
                    </p>
                    
                    <div
                      className="chart-container"
                      role="img"
                      aria-label={`Chart of forecast daily revenue per cart for the next ${salesFc?.horizon_days ?? 7} days.`}
                      style={{ opacity: isFcReady ? 1 : 0.4, pointerEvents: isFcReady ? "auto" : "none" }}
                    >
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={displayData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
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
                            tickFormatter={isFcReady ? fmtShortDate : undefined}
                          />
                          <YAxis
                            tick={{ fontSize: 11, fill: "var(--text-muted)" }}
                            tickLine={false}
                            axisLine={false}
                            tickFormatter={fmtMoneyAxis}
                            width={52}
                            domain={isFcReady ? [0, 'auto'] : [0, 1000]}
                          />
                          <Tooltip content={isFcReady ? <CustomTooltip /> : null} />
                          
                          {hasCartBreakdown_Forecast ? (
                            activeInventory
                              .filter((loc) => forecastSeriesData.some((d) => d[loc.code] !== undefined))
                              .map((loc, idx) => (
                                <Area
                                  key={loc.code}
                                  type="monotone"
                                  dataKey={loc.code}
                                  name={loc.code}
                                  stackId="1"
                                  stroke={CHART_COLORS[idx % CHART_COLORS.length]}
                                  strokeWidth={1.5}
                                  fill={CHART_COLORS[idx % CHART_COLORS.length]}
                                  fillOpacity={0.6}
                                  dot={false}
                                  activeDot={{ r: 4, fill: CHART_COLORS[idx % CHART_COLORS.length] }}
                                />
                              ))
                          ) : (
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
                          )}
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>

                    {hasCartBreakdown_Forecast && (
                      <div className="table-wrap" style={{ marginTop: "var(--space-3)" }}>
                        <table className="data compact">
                          <thead>
                            <tr>
                              <th>Cart</th>
                              <th className="t-right">Next {forecastHorizon} days</th>
                              <th className="t-right">Previous {forecastHorizon} days</th>
                              <th className="t-right">Change</th>
                            </tr>
                          </thead>
                          <tbody>
                            {forecastCartRows.map((row) => {
                              const prev = pastWindowByCart[row.code] ?? 0;
                              const pct = prev > 0 ? ((row.total - prev) / prev) * 100 : null;
                              return (
                                <tr key={row.code}>
                                  <td><strong>{row.code}</strong></td>
                                  <td className="t-right">P{Math.round(row.total).toLocaleString()}</td>
                                  <td className="t-right">{prev > 0 ? `P${Math.round(prev).toLocaleString()}` : "—"}</td>
                                  <td className="t-right">
                                    {pct == null ? (
                                      <span className="muted">—</span>
                                    ) : (
                                      <Badge variant={pct >= 0 ? "ok" : "danger"}>
                                        {pct >= 0 ? "+" : ""}{pct.toFixed(1)}%
                                      </Badge>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                            <tr>
                              <td><strong>All carts</strong></td>
                              <td className="t-right"><strong>P{Math.round(comparisonForecastTotal).toLocaleString()}</strong></td>
                              <td className="t-right"><strong>{pastWindowTotal > 0 ? `P${Math.round(pastWindowTotal).toLocaleString()}` : "—"}</strong></td>
                              <td className="t-right">
                                {expectedVariancePct == null ? (
                                  <span className="muted">—</span>
                                ) : (
                                  <Badge variant={isVarianceUp ? "ok" : "danger"}>
                                    {isVarianceUp ? "+" : ""}{expectedVariancePct.toFixed(1)}%
                                  </Badge>
                                )}
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
            {isOwner && profit && <ProfitSection profit={profit} />}
          </div>
        )}

        {loading && !trends && (
          <div className="analytics-loading" role="status" aria-label="Loading analytics" style={{ textAlign: "left", padding: 0 }}>
            <section className="panel analytics-summary-skeleton" aria-hidden="true">
              <div className="skel" style={{ width: "32%", height: 22 }} />
              <div className="skel" style={{ width: "92%", height: 14 }} />
              <div className="skel" style={{ width: "76%", height: 14 }} />
            </section>
            <SkeletonCards count={4} className="analytics-kpis" />
            <div className="analytics-loading-sections">
              <section className="analytics-section panel" aria-hidden="true">
                <div className="analytics-section-header">
                  <div className="skel" style={{ width: "28%", height: 18 }} />
                  <div className="skel" style={{ width: "20%", height: 12 }} />
                </div>
                <div className="skel analytics-skeleton-chart" />
              </section>
              <section className="analytics-section panel" aria-hidden="true">
                <div className="analytics-section-header">
                  <div className="skel" style={{ width: "30%", height: 18 }} />
                  <div className="skel" style={{ width: "24%", height: 12 }} />
                </div>
                <div className="skel analytics-skeleton-chart" />
              </section>
              
              {/* Sales Breakdown Skeleton */}
              <section className="analytics-section panel" aria-hidden="true">
                <div className="analytics-section-header">
                  <div className="skel" style={{ width: "24%", height: 18 }} />
                  <div className="skel" style={{ width: "22%", height: 12 }} />
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr", gap: "var(--space-4)" }}>
                  <div className="skel" style={{ height: 260, borderRadius: "50%", width: 260, margin: "0 auto" }} />
                  <TableSkeleton
                    className="analytics-skeleton-table"
                    rows={5}
                    fixedLayout
                    columns={[
                      { key: "rank", label: "#", width: 40 },
                      { key: "item", label: "Item" },
                      { key: "qty", label: "Qty", align: "right", width: 80 },
                      { key: "revenue", label: "Revenue", align: "right", width: 100 },
                    ]}
                  />
                </div>
              </section>

              <section className="analytics-section panel">
                <div className="analytics-section-header" aria-hidden="true">
                  <div className="skel" style={{ width: "28%", height: 18 }} />
                  <div className="skel" style={{ width: "32%", height: 12 }} />
                </div>
                <TableSkeleton
                  className="analytics-skeleton-table"
                  rows={5}
                  fixedLayout
                  columns={[
                    { key: "item", label: "Item" },
                    { key: "stock", label: "Stock" },
                    { key: "average", label: "Avg/day" },
                    { key: "depletion", label: "Depletion" },
                    { key: "smape", label: "sMAPE" },
                    { key: "risk", label: "Risk", skeletonType: "badge" },
                  ]}
                />
              </section>
              <section className="analytics-section panel" aria-hidden="true">
                <div className="analytics-section-header">
                  <div className="skel" style={{ width: "24%", height: 18 }} />
                  <div className="skel" style={{ width: "28%", height: 12 }} />
                </div>
                <div className="skel analytics-skeleton-chart" />
              </section>
            </div>
          </div>
        )}
      </div>
    </PageErrorBoundary>
  );
}