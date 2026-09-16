import { db as prisma } from "../firestore.js";
import {
  ANALYTICS_CONFIG as CFG,
  buildDailyUsage,
  sensorDailyRate,
  forecastForSeries,
  sampleStdDev,
  daysAgoStart,
} from "./analytics_engine.js";
import { manilaDayKey } from "./timezone.js";

const DAY_MS = 86400000;

// Shared predictive engine: consumption series per inventory item -> forecast.
// Used by both /analytics/forecast and /reorders/suggestions.
export async function buildForecastForLocation(locationId) {
  const horizon = CFG.HORIZON_DAYS;
  const windowDays = Math.max(CFG.MIN_DAYS_FOR_FORECAST + 7, 21);

  const [inventory, usage] = await Promise.all([
    prisma.inventoryItem.findMany({
      where: { locationId },
      orderBy: { name: "asc" },
    }),
    buildDailyUsage(locationId, windowDays),
  ]);

  const allKeys = [];
  for (let d = windowDays - 1; d >= 0; d--) allKeys.push(manilaDayKey(daysAgoStart(d)));

  const items = [];
  for (const inv of inventory) {
    const dayMap = usage.get(inv.name);
    let series;
    let trackedVia;

    if (dayMap && dayMap.size > 0) {
      trackedVia = "recipes";
      series = allKeys.map((k) => ({ key: k, value: dayMap.get(k) ?? 0 }));
    } else if (inv.source === "SENSOR") {
      trackedVia = "sensor";
      const channel = inv.name === "LPG Tank" ? "LPG_TANK" : "CHEESE_BIN";
      const rate = await sensorDailyRate(locationId, channel, 5);
      if (!rate) {
        items.push({
          name: inv.name,
          unit: inv.unit,
          current_stock: inv.stock,
          threshold: inv.threshold,
          source: inv.source,
          tracked_via: trackedVia,
          data_sufficient: false,
          reason: "not enough sensor readings yet",
        });
        continue;
      }
      series = allKeys.map((k) => ({ key: k, value: rate }));
    } else {
      items.push({
        name: inv.name,
        unit: inv.unit,
        current_stock: inv.stock,
        threshold: inv.threshold,
        source: inv.source,
        tracked_via: "untracked",
        data_sufficient: false,
        reason: "no recipe or sensor mapping for this item",
      });
      continue;
    }

    const fc = forecastForSeries(series, {
      horizon,
      minDays: CFG.MIN_DAYS_FOR_FORECAST,
    });

    let depletionDays = null;
    let risk = "unknown";
    if (fc.data_sufficient && fc.avg_daily_use > 0) {
      depletionDays = inv.stock / fc.avg_daily_use;
      risk =
        depletionDays <= CFG.LEAD_TIME_DAYS
          ? "high"
          : depletionDays <= CFG.LEAD_TIME_DAYS * 2.5
          ? "medium"
          : "low";
    }

    items.push({
      name: inv.name,
      unit: inv.unit,
      current_stock: inv.stock,
      threshold: inv.threshold,
      source: inv.source,
      tracked_via: trackedVia,
      avg_daily_use: fc.avg_daily_use,
      std_dev: Number(sampleStdDev(series.map((s) => s.value)).toFixed(3)),
      data_sufficient: fc.data_sufficient,
      reason: fc.reason,
      forecast: fc.forecast,
      mape_pct: fc.mape,
      depletion_days: depletionDays !== null ? Number(depletionDays.toFixed(1)) : null,
      depletion_date:
        depletionDays !== null
          ? manilaDayKey(new Date(Date.now() + depletionDays * DAY_MS))
          : null,
      risk,
    });
  }

  return {
    horizon_days: horizon,
    config: CFG,
    generated_at: new Date().toISOString(),
    items: items.sort((a, b) => a.name.localeCompare(b.name)),
  };
}
