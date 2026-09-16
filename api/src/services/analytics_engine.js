import { db as prisma } from "../firestore.js";
import {
  manilaDayKey as dayKey,
  manilaDayStart as daysAgoStart,
  manilaDow,
  manilaHour,
  manilaDowOfKey,
  manilaCalendarToday,
} from "./timezone.js";
import { mapsForOrderLine } from "./inventory_rules.js";

// Re-exported so existing import sites keep working; canonical impl lives
// in services/timezone.js (single source of truth, no drift).
export { daysAgoStart };

export const ANALYTICS_CONFIG = {
  MIN_DAYS_FOR_FORECAST: 14, // proposal: forecasts activate after 2-4 weeks of data
  HORIZON_DAYS: 7,
  LEAD_TIME_DAYS: 2, // supplier lead time (Sta. Cruz same/next-day delivery)
  REVIEW_PERIOD_DAYS: 7,
  SERVICE_Z: 1.65, // ~95% service level for safety stock
};

const DAY_MS = 86400000;

// ---------- statistics helpers (practical/statistical tier) ----------

export function movingAverage(values, window = 7) {
  if (values.length === 0) return 0;
  const slice = values.slice(-window);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

export function linearRegression(values) {
  const n = values.length;
  if (n < 2) return { slope: 0, intercept: values[0] ?? 0 };
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX;
  const slope = denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

export function weekdayFactors(dayKeys, values) {
  const sums = Array(7).fill(0);
  const counts = Array(7).fill(0);
  dayKeys.forEach((key, i) => {
    const dow = manilaDowOfKey(key);
    sums[dow] += values[i];
    counts[dow] += 1;
  });
  const overallAvg = values.reduce((a, b) => a + b, 0) / Math.max(values.length, 1);
  if (overallAvg <= 0) return Array(7).fill(1);
  return sums.map((s, i) => {
    if (counts[i] === 0) return 1;
    const f = s / counts[i] / overallAvg;
    return Math.min(1.6, Math.max(0.4, f)); // clamp extreme factors
  });
}

export function sampleStdDev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function mape(actual, predicted) {
  const pairs = actual
    .map((a, i) => [a, predicted[i]])
    .filter(([a]) => a > 0);
  if (pairs.length === 0) return null;
  const err =
    pairs.reduce((acc, [a, p]) => acc + Math.abs(a - p) / a, 0) / pairs.length;
  return Number((err * 100).toFixed(1));
}

// ---------- consumption series per inventory item ----------

export async function buildDailyUsage(locationId, windowDays) {
  const since = daysAgoStart(windowDays - 1);
  const [orders, maps] = await Promise.all([
    prisma.order.findMany({
      where: { locationId, status: "PAID", createdAt: { gte: since } },
      include: { items: true },
    }),
    prisma.ingredientMap.findMany(),
  ]);

  // itemName -> Map<dayKey, kgUsed>
  const usage = new Map();
  const bump = (itemName, key, amount) => {
    if (!usage.has(itemName)) usage.set(itemName, new Map());
    const dayMap = usage.get(itemName);
    dayMap.set(key, (dayMap.get(key) ?? 0) + amount);
  };

  for (const order of orders) {
    const key = dayKey(order.createdAt);
    for (const item of order.items) {
      // Same recipe resolution as the POS deduction (mapsForOrderLine):
      // every matching generic + the best specific per itemName, so usage
      // can never undercount multi-ingredient products.
      for (const map of mapsForOrderLine(maps, item.productName, item.flavor ?? "")) {
        bump(map.itemName, key, map.amountPerUnit * item.qty);
      }
    }
  }
  return usage;
}

export async function sensorDailyRate(locationId, channel, lookbackDays = 5) {
  const since = daysAgoStart(lookbackDays);
  const readings = await prisma.sensorReading.findMany({
    where: { locationId, channel, ts: { gte: since } },
    orderBy: { ts: "asc" },
  });
  if (readings.length < 4) return null;
  const first = readings[0];
  const last = readings[readings.length - 1];
  const spanDays = (last.ts - first.ts) / DAY_MS;
  if (spanDays <= 0) return null;
  const used = first.kg - last.kg;
  if (used <= 0) return null;
  return used / spanDays; // kg/day average over the lookback window
}

// ---------- hourly sales matrix (descriptive: peak-hour staffing) ----------

export function daypart(hour) {
  if (hour < 11) return "morning";
  if (hour < 14) return "lunch";
  if (hour < 17) return "afternoon";
  return "evening";
}

// 7 x 24 matrix of {dow, hour, orders, total_sales} plus peak summaries.
// Weekday uses server-local time, same convention as the trends endpoint.
export function buildHourlyMatrix(orders) {
  const cells = new Map();
  const key = (dow, hour) => `${dow}:${hour}`;
  for (const o of orders) {
    const d = new Date(o.createdAt);
    const k = key(manilaDow(d), manilaHour(d));
    const cell = cells.get(k) ?? { orders: 0, total_sales: 0 };
    cell.orders += 1;
    cell.total_sales += o.total;
    cells.set(k, cell);
  }
  const matrix = [];
  for (let dow = 0; dow < 7; dow++) {
    for (let hour = 0; hour < 24; hour++) {
      const cell = cells.get(key(dow, hour)) ?? { orders: 0, total_sales: 0 };
      matrix.push({
        dow,
        hour,
        daypart: daypart(hour),
        orders: cell.orders,
        total_sales: Number(cell.total_sales.toFixed(2)),
      });
    }
  }
  let peak = { dow: 0, hour: 0, orders: 0, total_sales: 0 };
  for (const c of matrix) {
    if (c.total_sales > peak.total_sales) peak = c;
  }
  const byPart = {};
  for (const c of matrix) {
    const p = byPart[c.daypart] ?? { orders: 0, total_sales: 0 };
    p.orders += c.orders;
    p.total_sales += c.total_sales;
    byPart[c.daypart] = p;
  }
  return {
    matrix,
    peak,
    by_daypart: Object.entries(byPart).map(([part, v]) => ({
      part,
      orders: v.orders,
      total_sales: Number(v.total_sales.toFixed(2)),
    })),
  };
}

// ---------- basket analysis (descriptive: what sells together) ----------

export function buildBasket(paidOrders, voidCount) {
  const totalOrders = paidOrders.length;
  let units = 0;
  let lines = 0;
  const pairCounts = new Map();
  for (const o of paidOrders) {
    const keys = (o.items ?? []).map(
      (it) => `${it.productName}|${it.flavor ?? ""}`
    );
    units += (o.items ?? []).reduce((s, it) => s + (it.qty ?? 0), 0);
    lines += (o.items ?? []).length;
    const uniq = [...new Set(keys)].sort();
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        const k = `${uniq[i]} + ${uniq[j]}`;
        pairCounts.set(k, (pairCounts.get(k) ?? 0) + 1);
      }
    }
  }
  const topPairs = [...pairCounts.entries()]
    .map(([pair, orders]) => ({
      pair: pair.split(" + ").map((p) => {
        const [name, flavor] = p.split("|");
        return flavor ? `${name} (${flavor})` : name;
      }),
      orders,
      pct:
        totalOrders > 0 ? Number(((orders / totalOrders) * 100).toFixed(1)) : 0,
    }))
    .sort((a, b) => b.orders - a.orders)
    .slice(0, 5);
  const all = totalOrders + voidCount;
  return {
    orders: totalOrders,
    void_orders: voidCount,
    void_rate_pct:
      all > 0 ? Number(((voidCount / all) * 100).toFixed(1)) : 0,
    avg_units_per_ticket:
      totalOrders > 0 ? Number((units / totalOrders).toFixed(2)) : 0,
    avg_lines_per_ticket:
      totalOrders > 0 ? Number((lines / totalOrders).toFixed(2)) : 0,
    top_pairs: topPairs,
  };
}

// ---------- forecast assembly for one item ----------

export function forecastForSeries(seriesEntries, { horizon, minDays }) {
  // seriesEntries: [{key:"YYYY-MM-DD", value:number}] covering the full window
  const keys = seriesEntries.map((e) => e.key);
  const values = seriesEntries.map((e) => e.value);
  const totalUse = values.reduce((a, b) => a + b, 0);
  const activeDays = values.filter((v) => v > 0).length;

  if (activeDays < 3 || totalUse <= 0) {
    return {
      data_sufficient: false,
      reason: `only ${activeDays} day(s) with recorded usage - need at least ${minDays}`,
      avg_daily_use: 0,
      forecast: [],
      depletion_days: null,
      risk: "unknown",
      mape: null,
    };
  }

  const factors = weekdayFactors(keys, values);
  const deseasonalized = values.map(
    (v, i) => v / (factors[manilaDowOfKey(keys[i])] || 1)
  );

  // Backtest MAPE on the last 3 observed days using prior data only.
  let mapeValue = null;
  if (deseasonalized.length >= 6) {
    const trainCut = deseasonalized.length - 3;
    const train = deseasonalized.slice(0, trainCut);
    const { slope, intercept } = linearRegression(train);
    const ma = movingAverage(train);
    const predActual = [];
    const predValues = [];
    for (let d = 0; d < 3; d++) {
      const idx = trainCut + d;
      const dow = manilaDowOfKey(keys[idx]);
      const trend = Math.max(0, intercept + slope * idx);
      const blended = 0.5 * trend + 0.5 * ma;
      predActual.push(values[idx]);
      predValues.push(blended * (factors[dow] || 1));
    }
    mapeValue = mape(predActual, predValues);
  }

  const ma = movingAverage(deseasonalized);
  const { slope, intercept } = linearRegression(deseasonalized);
  const forecast = [];
  // Manila-calendar arithmetic: labels stay on business days regardless of
  // server timezone (UTC getters on a UTC-anchored calendar date).
  const today = manilaCalendarToday();
  for (let h = 1; h <= horizon; h++) {
    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() + h);
    const dow = date.getUTCDay();
    const trend = Math.max(0, intercept + slope * deseasonalized.length + (h - 1) * slope);
    const blended = 0.5 * trend + 0.5 * ma; // conservative blend
    forecast.push({
      date: date.toISOString().slice(0, 10),
      expected_use: Number((blended * (factors[dow] || 1)).toFixed(3)),
    });
  }

  const avgDailyUse = movingAverage(values);
  return {
    data_sufficient: activeDays >= minDays,
    reason:
      activeDays >= minDays
        ? null
        : `forecast activates after ${minDays} days of data (currently ${activeDays})`,
    avg_daily_use: Number(avgDailyUse.toFixed(3)),
    forecast,
    mape: mapeValue,
  };
}
