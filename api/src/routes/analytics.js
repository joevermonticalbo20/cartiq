import { Router } from "express";
import { prisma } from "../prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { ANALYTICS_CONFIG as CFG } from "../services/analytics_engine.js";
import { buildForecastForLocation } from "../services/forecast_service.js";
import {
  daysAgoStart,
  buildHourlyMatrix,
  buildBasket,
  forecastForSeries,
  buildDailyUsage,
  weekdayFactors,
  movingAverage,
} from "../services/analytics_engine.js";

const router = Router();

function dayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate()
  ).padStart(2, "0")}`;
}
const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

async function getLocation(codeOrId) {
  if (codeOrId === undefined || codeOrId === null || codeOrId === "") return null;
  return prisma.location.findFirst({
    where: /^\d+$/.test(String(codeOrId))
      ? { id: Number(codeOrId) }
      : { code: String(codeOrId) },
  });
}

// ---------------- descriptive ----------------
// GET /api/analytics/trends?days=28&code=CART-01
router.get("/analytics/trends", requireAuth, async (req, res, next) => {
  try {
    const days = Math.min(Number(req.query.days) || 28, 90);
    const location = await getLocation(req.query.code);
    const since = daysAgoStart(days - 1);

    const orders = await prisma.order.findMany({
      where: {
        status: "PAID",
        createdAt: { gte: since },
        ...(location ? { locationId: location.id } : {}),
      },
      include: {
        items: true,
        location: { select: { code: true, name: true } },
      },
    });

    const byWeekday = Array.from({ length: 7 }, (_, i) => ({
      dow: i,
      label: DOW_LABELS[i],
      total_sales: 0,
      orders: 0,
    }));
    const dailyMap = new Map();
    const locMap = new Map();
    const itemMap = new Map();

    for (const o of orders) {
      const dow = new Date(o.createdAt).getDay();
      byWeekday[dow].total_sales += o.total;
      byWeekday[dow].orders += 1;

      const key = dayKey(o.createdAt);
      dailyMap.set(key, (dailyMap.get(key) ?? 0) + o.total);

      const locEntry =
        locMap.get(o.location.code) ?? {
          code: o.location.code,
          name: o.location.name,
          total_sales: 0,
          orders: 0,
        };
      locEntry.total_sales += o.total;
      locEntry.orders += 1;
      locMap.set(o.location.code, locEntry);

      for (const it of o.items) {
        const ik = `${it.productName}|${it.flavor ?? ""}`;
        const entry =
          itemMap.get(ik) ?? { name: it.productName, flavor: it.flavor, qty: 0, sales: 0 };
        entry.qty += it.qty;
        entry.sales += it.qty * it.unitPrice;
        itemMap.set(ik, entry);
      }
    }

    const items = [...itemMap.values()].sort((a, b) => b.qty - a.qty);
    const daily_series = [];
    for (let d = days - 1; d >= 0; d--) {
      const date = daysAgoStart(d);
      const key = dayKey(date);
      daily_series.push({
        date: key,
        total_sales: Number((dailyMap.get(key) ?? 0).toFixed(2)),
      });
    }

    return res.json({
      period_days: days,
      location: location?.code ?? "ALL",
      total_sales: Number(orders.reduce((s, o) => s + o.total, 0).toFixed(2)),
      orders: orders.length,
      by_weekday: byWeekday.map((w) => ({
        ...w,
        total_sales: Number(w.total_sales.toFixed(2)),
      })),
      locations: [...locMap.values()].map((l) => ({
        ...l,
        total_sales: Number(l.total_sales.toFixed(2)),
      })),
      top_items: items.slice(0, 5),
      slow_items: items.slice(-3).reverse(),
      daily_series,
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------- descriptive: peak hours ----------------
// GET /api/analytics/hourly?days=28&code=CART-01
router.get("/analytics/hourly", requireAuth, async (req, res, next) => {
  try {
    const days = Math.min(Number(req.query.days) || 28, 90);
    const location = await getLocation(req.query.code);
    const since = daysAgoStart(days - 1);

    const orders = await prisma.order.findMany({
      where: {
        status: "PAID",
        createdAt: { gte: since },
        ...(location ? { locationId: location.id } : {}),
      },
      select: { total: true, createdAt: true },
    });

    return res.json({
      period_days: days,
      location: location?.code ?? "ALL",
      ...buildHourlyMatrix(orders),
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------- descriptive: basket ----------------
// GET /api/analytics/basket?days=28&code=CART-01
router.get("/analytics/basket", requireAuth, async (req, res, next) => {
  try {
    const days = Math.min(Number(req.query.days) || 28, 90);
    const location = await getLocation(req.query.code);
    const since = daysAgoStart(days - 1);
    const where = {
      createdAt: { gte: since },
      ...(location ? { locationId: location.id } : {}),
    };

    const [paid, voidCount] = await Promise.all([
      prisma.order.findMany({
        where: { ...where, status: "PAID" },
        include: { items: true },
      }),
      prisma.order.count({ where: { ...where, status: "VOID" } }),
    ]);

    return res.json({
      period_days: days,
      location: location?.code ?? "ALL",
      ...buildBasket(paid, voidCount),
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------- predictive: revenue forecast ----------------
// GET /api/analytics/sales-forecast?days=28&code=CART-01&horizon=7
// Same deseasonalized MA + trend engine as the inventory forecast,
// applied to daily revenue. Shares the 14-day cold-start gate.
router.get("/analytics/sales-forecast", requireAuth, async (req, res, next) => {
  try {
    const days = Math.min(Number(req.query.days) || 28, 90);
    const horizon = Math.min(Number(req.query.horizon) || 7, 14);
    const location = await getLocation(req.query.code);
    const since = daysAgoStart(days - 1);

    const orders = await prisma.order.findMany({
      where: {
        status: "PAID",
        createdAt: { gte: since },
        ...(location ? { locationId: location.id } : {}),
      },
      select: { total: true, createdAt: true },
    });

    const dailyMap = new Map();
    for (const o of orders) {
      const k = dayKey(o.createdAt);
      dailyMap.set(k, (dailyMap.get(k) ?? 0) + o.total);
    }
    const entries = [];
    for (let d = days - 1; d >= 0; d--) {
      const k = dayKey(daysAgoStart(d));
      entries.push({ key: k, value: Number((dailyMap.get(k) ?? 0).toFixed(2)) });
    }

    const result = forecastForSeries(entries, {
      horizon,
      minDays: CFG.MIN_DAYS_FOR_FORECAST,
    });
    return res.json({
      period_days: days,
      horizon_days: horizon,
      location: location?.code ?? "ALL",
      ...result,
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------- predictive ----------------
// GET /api/analytics/forecast?code=CART-01&horizon=7
router.get("/analytics/forecast", requireAuth, async (req, res, next) => {
  try {
    const location = await getLocation(req.query.code ?? "CART-01");
    if (!location) return res.status(404).json({ error: "Location not found" });

    const result = await buildForecastForLocation(location.id);
    return res.json({ code: location.code, ...result });
  } catch (err) {
    return next(err);
  }
});

// ---------------- prescriptive ----------------
// GET /api/reorders/suggestions?code=CART-01
router.get("/reorders/suggestions", requireAuth, async (req, res, next) => {
  try {
    const location = await getLocation(req.query.code ?? "CART-01");
    if (!location) return res.status(404).json({ error: "Location not found" });

    const forecast = await buildForecastForLocation(location.id);
    const lead = CFG.LEAD_TIME_DAYS;

    const suggestions = [];
    for (const item of forecast.items) {
      if (!item.data_sufficient) {
        suggestions.push({
          item: item.name,
          unit: item.unit,
          current_stock: item.current_stock,
          urgency: item.current_stock <= item.threshold ? "manual_check" : "none",
          suggested_qty: null,
          reorder_point: null,
          reason:
            item.reason ??
            "insufficient history - follow static threshold and manual counts",
        });
        continue;
      }

      const safetyStock = CFG.SERVICE_Z * (item.std_dev ?? 0) * Math.sqrt(lead);
      const reorderPoint = item.avg_daily_use * lead + safetyStock;
      const targetCycle = item.avg_daily_use * (lead + CFG.REVIEW_PERIOD_DAYS);
      const suggestedQty = Math.max(0, Math.ceil(targetCycle - item.current_stock));

      let urgency = "ok";
      let reason = `stock healthy (${item.depletion_days} days to depletion at current usage)`;
      if (item.risk === "high") {
        urgency = "immediate";
        reason = `projected depletion ${item.depletion_date} is within the ${lead}-day supplier lead time`;
      } else if (item.risk === "medium" || item.current_stock <= item.threshold) {
        urgency = "this_week";
        reason = `approaching reorder point (${reorderPoint.toFixed(1)} ${item.unit})`;
      }

      suggestions.push({
        item: item.name,
        unit: item.unit,
        current_stock: item.current_stock,
        avg_daily_use: item.avg_daily_use,
        reorder_point: Number(reorderPoint.toFixed(2)),
        safety_stock: Number(safetyStock.toFixed(2)),
        suggested_qty: suggestedQty,
        urgency,
        reason,
        mape_pct: item.mape_pct,
        depletion_days: item.depletion_days ?? null,
        depletion_date: item.depletion_date ?? null,
      });
    }

    const order = { immediate: 0, this_week: 1, manual_check: 2, ok: 3, none: 4 };
    suggestions.sort((a, b) => (order[a.urgency] ?? 9) - (order[b.urgency] ?? 9));

    // Dated stockout alerts for the attention queue: "Cheese runs out Fri".
    // Presentation-layer (no DB writes) so re-fetching never spams alerts.
    const alerts = suggestions
      .filter((s) => s.urgency === "immediate" || s.urgency === "this_week")
      .map((s) => ({
        severity: s.urgency === "immediate" ? "critical" : "warning",
        item: s.item,
        depletion_date: s.depletion_date ?? null,
        message:
          s.urgency === "immediate"
            ? `${s.item} runs out ${s.depletion_date ?? "soon"} - reorder now`
            : `${s.item} approaching reorder point - order this week`,
      }));

    return res.json({
      code: location.code,
      lead_time_days: lead,
      generated_at: new Date().toISOString(),
      suggestions,
      alerts,
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------- prescriptive: prep quantities + threshold review ----------------
// GET /api/reorders/prep?code=CART-01&days=3
//
// Prep: expected usage over the next N calendar days per item, using the
// trailing average scaled by weekday factors ("prep 3.2kg cheese for Sat").
// Calibration: flags noisy thresholds (>=3 LOW_STOCK alerts in 30d while
// stock stays healthy) and silent ones (at/below threshold, never alerted),
// each with a one-click suggested_threshold (PATCH /inventory/items/:id).
router.get("/reorders/prep", requireAuth, async (req, res, next) => {
  try {
    const location = await getLocation(req.query.code ?? "CART-01");
    if (!location) return res.status(404).json({ error: "Location not found" });
    const days = Math.min(Math.max(Number(req.query.days) || 3, 1), 7);
    const windowDays = 21;

    const [usage, items, alerts] = await Promise.all([
      buildDailyUsage(location.id, windowDays),
      prisma.inventoryItem.findMany({
        where: { locationId: location.id },
        orderBy: { name: "asc" },
      }),
      prisma.alert.findMany({
        where: {
          type: "LOW_STOCK",
          createdAt: { gte: daysAgoStart(30) },
        },
        select: { payload: true },
      }),
    ]);

    const alertCounts = new Map();
    for (const a of alerts) {
      try {
        const id = JSON.parse(a.payload ?? "{}")?.inventoryItemId;
        if (Number.isInteger(id)) {
          alertCounts.set(id, (alertCounts.get(id) ?? 0) + 1);
        }
      } catch {
        // Unparseable legacy payload - skip.
      }
    }

    const upcoming = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let h = 0; h < days; h++) {
      const d = new Date(today);
      d.setDate(d.getDate() + h);
      upcoming.push(d.getDay());
    }

    const prep = [];
    const calibration = [];
    for (const inv of items) {
      const dayMap = usage.get(inv.name) ?? new Map();
      const keys = [];
      const values = [];
      for (let d = windowDays - 1; d >= 0; d--) {
        const k = dayKey(daysAgoStart(d));
        keys.push(k);
        values.push(dayMap.get(k) ?? 0);
      }
      const activeDays = values.filter((v) => v > 0).length;
      if (activeDays < 3) {
        prep.push({
          item: inv.name,
          unit: inv.unit,
          current_stock: inv.stock,
          expected_use: null,
          prep_qty: null,
          shortfall: null,
          data_sufficient: false,
          reason: "needs at least 3 days of usage history",
        });
      } else {
        const factors = weekdayFactors(keys, values);
        const avg = movingAverage(values);
        const expected = upcoming.reduce(
          (s, dow) => s + avg * (factors[dow] ?? 1),
          0
        );
        const expectedRounded = Math.ceil(expected * 10) / 10;
        prep.push({
          item: inv.name,
          unit: inv.unit,
          current_stock: inv.stock,
          expected_use: expectedRounded,
          prep_qty: expectedRounded,
          shortfall: Number(Math.max(0, expectedRounded - inv.stock).toFixed(1)),
          data_sufficient: true,
          reason: null,
        });
      }

      const alertCount = alertCounts.get(inv.id) ?? 0;
      if (alertCount >= 3 && inv.stock > inv.threshold) {
        calibration.push({
          inventory_item_id: inv.id,
          item: inv.name,
          alerts_30d: alertCount,
          current_threshold: inv.threshold,
          verdict: "noisy",
          suggested_threshold: Math.max(1, Math.ceil(inv.threshold / 2)),
          reason: `alerted ${alertCount}x in 30d while stock stayed healthy - threshold likely too high`,
        });
      } else if (alertCount === 0 && inv.stock <= inv.threshold) {
        calibration.push({
          inventory_item_id: inv.id,
          item: inv.name,
          alerts_30d: 0,
          current_threshold: inv.threshold,
          verdict: "silent",
          suggested_threshold: inv.threshold,
          reason:
            "at/below threshold but never alerted - counts may bypass adjustments (e.g. sensor updates)",
        });
      }
    }
    prep.sort((a, b) => (b.shortfall ?? -1) - (a.shortfall ?? -1));

    return res.json({
      code: location.code,
      days,
      generated_at: new Date().toISOString(),
      prep,
      calibration,
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------- staff performance ----------------
// GET /api/analytics/staff-performance?days=28
router.get("/analytics/staff-performance", requireAuth, async (req, res, next) => {
  try {
    const days = Math.min(Number(req.query.days) || 28, 90);
    const since = daysAgoStart(days - 1);

    // Aggregate PAID orders per staff
    const orders = await prisma.order.findMany({
      where: { status: "PAID", createdAt: { gte: since } },
      include: { staff: { select: { id: true, name: true, username: true } } },
    });

    // Count IN/OUT events per staff for shift count
    const shifts = await prisma.shift.findMany({
      where: { ts: { gte: since } },
      include: {
        staff: { select: { id: true, name: true, username: true } },
      },
    });

    const byStaff = new Map();
    for (const o of orders) {
      if (!o.staff) continue;
      const key = o.staff.id;
      const entry = byStaff.get(key) ?? {
        staff_id: o.staff.id,
        name: o.staff.name,
        username: o.staff.username,
        orders: 0,
        total_sales: 0,
        avg_ticket: 0,
        items_sold: 0,
      };
      entry.orders += 1;
      entry.total_sales += o.total;
      byStaff.set(key, entry);
    }

    for (const s of shifts) {
      if (!s.staff) continue;
      const key = s.staff.id;
      const entry = byStaff.get(key) ?? {
        staff_id: s.staff.id,
        name: s.staff.name,
        username: s.staff.username,
        orders: 0,
        total_sales: 0,
        avg_ticket: 0,
        items_sold: 0,
      };
      if (s.event === "IN") entry.shifts_in = (entry.shifts_in ?? 0) + 1;
      if (s.event === "OUT") entry.shifts_out = (entry.shifts_out ?? 0) + 1;
      byStaff.set(key, entry);
    }

    // Compute final aggregates
    const summary = [...byStaff.values()].map((e) => ({
      ...e,
      avg_ticket: e.orders > 0 ? Number((e.total_sales / e.orders).toFixed(2)) : 0,
      total_sales: Number(e.total_sales.toFixed(2)),
      shifts_completed: Math.min(e.shifts_in ?? 0, e.shifts_out ?? 0),
    }));
    summary.sort((a, b) => b.total_sales - a.total_sales);

    return res.json({
      period_days: days,
      generated_at: new Date().toISOString(),
      staff: summary,
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------- profit & expenses ----------------
// GET /api/analytics/profit?days=30&code=CART-01
router.get("/analytics/profit", requireAuth, async (req, res, next) => {
  try {
    const days = Math.min(Number(req.query.days) || 30, 90);
    const location = await getLocation(req.query.code);
    const since = daysAgoStart(days - 1);

    const orders = await prisma.order.findMany({
      where: {
        status: "PAID",
        createdAt: { gte: since },
        ...(location ? { locationId: location.id } : {}),
      },
      select: { total: true, createdAt: true },
    });

    const expenses = await prisma.expense.findMany({
      where: { date: { gte: since }, ...(location ? { locationId: location.id } : {}) },
      select: { category: true, amount: true, date: true },
    });

    const categories = ["Supplies", "LPG/Gas", "Maintenance", "Fees/Rent", "Other"];
    const categoryMap = new Map();
    categories.forEach(c => categoryMap.set(c, 0));
    let totalExpenses = 0;

    for (const e of expenses) {
      const cat = categories.includes(e.category) ? e.category : "Other";
      categoryMap.set(cat, categoryMap.get(cat) + Number(e.amount));
      totalExpenses += Number(e.amount);
    }

    const expensesByCategory = categories.map(cat => ({
      category: cat,
      amount: Number(categoryMap.get(cat).toFixed(2)),
      pct: totalExpenses > 0 ? Number(((categoryMap.get(cat) / totalExpenses) * 100).toFixed(2)) : 0,
    }));

    const revenueByDay = new Map();
    for (const o of orders) {
      const key = dayKey(o.createdAt);
      revenueByDay.set(key, (revenueByDay.get(key) ?? 0) + o.total);
    }

    const expenseByDay = new Map();
    for (const e of expenses) {
      const key = dayKey(e.date);
      expenseByDay.set(key, (expenseByDay.get(key) ?? 0) + Number(e.amount));
    }

    const dailyProfit = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = daysAgoStart(i);
      const localKey = dayKey(date);
      const rev = Number((revenueByDay.get(localKey) ?? 0).toFixed(2));
      const exp = Number((expenseByDay.get(localKey) ?? 0).toFixed(2));
      dailyProfit.push({ date: localKey, revenue: rev, expenses: exp, profit: Number((rev - exp).toFixed(2)) });
    }

    const revenue = Number((orders.reduce((s, o) => s + o.total, 0) || 0).toFixed(2));
    const grossProfit = Number((revenue - totalExpenses).toFixed(2));
    const margin = revenue > 0 ? Number(((grossProfit / revenue) * 100).toFixed(2)) : 0;

    return res.json({
      period_days: days,
      location: location?.code ?? "ALL",
      revenue,
      total_expenses: Number(totalExpenses.toFixed(2)),
      gross_profit: grossProfit,
      margin_pct: margin,
      order_count: orders.length,
      expense_count: expenses.length,
      expenses_by_category: expensesByCategory,
      daily_profit: dailyProfit,
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
