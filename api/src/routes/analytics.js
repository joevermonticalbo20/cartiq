import { Router } from "express";
import { prisma } from "../prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { ANALYTICS_CONFIG as CFG } from "../services/analytics_engine.js";
import { buildForecastForLocation } from "../services/forecast_service.js";
import { daysAgoStart } from "../services/analytics_engine.js";

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
      });
    }

    const order = { immediate: 0, this_week: 1, manual_check: 2, ok: 3, none: 4 };
    suggestions.sort((a, b) => (order[a.urgency] ?? 9) - (order[b.urgency] ?? 9));

    return res.json({
      code: location.code,
      lead_time_days: lead,
      generated_at: new Date().toISOString(),
      suggestions,
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
