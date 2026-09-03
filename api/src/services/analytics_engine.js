import { prisma } from "../prisma.js";

export const ANALYTICS_CONFIG = {
  MIN_DAYS_FOR_FORECAST: 14, // proposal: forecasts activate after 2-4 weeks of data
  HORIZON_DAYS: 7,
  LEAD_TIME_DAYS: 2, // supplier lead time (Sta. Cruz same/next-day delivery)
  REVIEW_PERIOD_DAYS: 7,
  SERVICE_Z: 1.65, // ~95% service level for safety stock
};

const DAY_MS = 86400000;

function dayKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

export function daysAgoStart(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
}

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
    const dow = new Date(`${key}T00:00:00`).getDay();
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
      const specific = maps.find(
        (m) =>
          m.productName === item.productName &&
          m.flavor !== "" &&
          m.flavor === (item.flavor ?? "")
      );
      const generic = maps.find(
        (m) => m.productName === item.productName && m.flavor === ""
      );
      const applied = [];
      if (generic) applied.push(generic);
      if (specific && specific.itemName !== generic?.itemName) applied.push(specific);
      else if (specific && !generic) applied.push(specific);
      for (const map of applied) {
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
    (v, i) => v / (factors[new Date(`${keys[i]}T00:00:00`).getDay()] || 1)
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
      const dow = new Date(`${keys[idx]}T00:00:00`).getDay();
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
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let h = 1; h <= horizon; h++) {
    const date = new Date(today);
    date.setDate(date.getDate() + h);
    const dow = date.getDay();
    const trend = Math.max(0, intercept + slope * deseasonalized.length + (h - 1) * slope);
    const blended = 0.5 * trend + 0.5 * ma; // conservative blend
    forecast.push({
      date: dayKey(date),
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
