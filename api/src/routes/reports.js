import { Router } from "express";
import { db as prisma } from "../firestore.js";
import { requireAuth } from "../middleware/auth.js";
import { manilaDayKey, manilaDayRange, manilaDayStart } from "../services/timezone.js";

const router = Router();

// GET /api/public/sales-today — read-only aggregate for the unauthenticated
// login preview. No items, carts, or staff details are exposed.
router.get("/public/sales-today", async (_req, res, next) => {
  try {
    const day = manilaDayStart(0);
    const nextDay = new Date(day.getTime() + 24 * 60 * 60 * 1000);
    const weekStart = manilaDayStart(6);
    const orders = await prisma.order.findMany({
      where: { createdAt: { gte: weekStart, lt: nextDay }, status: "PAID" },
      select: { total: true, createdAt: true },
    });
    const todayOrders = orders.filter(
      (o) => o.createdAt >= day && o.createdAt < nextDay
    );
    const totalSales = todayOrders.reduce((sum, o) => sum + (Number(o.total) || 0), 0);
    // The last 7 days of daily sales (aggregate only) so the login preview
    // can draw a REAL chart instead of made-up bars.
    const byDay = new Map();
    for (const o of orders) {
      const key = manilaDayKey(o.createdAt);
      byDay.set(key, (byDay.get(key) ?? 0) + (Number(o.total) || 0));
    }
    const weekly = [];
    for (let d = 6; d >= 0; d--) {
      const key = manilaDayKey(manilaDayStart(d));
      weekly.push({ date: key, total_sales: Number((byDay.get(key) ?? 0).toFixed(2)) });
    }
    // Login preview cart chips: only the cart code plus the worst stock
    // status across its items. No names, quantities, or item details.
    const inventoryStatus = (stock, threshold) => {
      if (stock <= threshold / 2) return "critical";
      if (stock <= threshold) return "low";
      return "ok";
    };
    const locations = await prisma.location.findMany({
      include: { inventory: { select: { stock: true, threshold: true } } },
      orderBy: { code: "asc" },
    });
    const carts = locations
      .filter((loc) => loc.status !== "INACTIVE")
      .map((loc) => {
        let status = "ok";
        for (const item of loc.inventory ?? []) {
          const itemStatus = inventoryStatus(Number(item.stock) || 0, Number(item.threshold) || 0);
          if (itemStatus === "critical") {
            status = "critical";
            break;
          }
          if (itemStatus === "low") status = "low";
        }
        return { code: loc.code, status };
      });
    const pad = (n) => String(n).padStart(2, "0");
    const manilaDay = new Date(day.getTime() + 8 * 60 * 60 * 1000);
    // A live preview must not sit in a browser cache for minutes: the
    // "SALES TODAY" number was frozen for up to 5 minutes after a sale, so the
    // login screen showed P0 while the order already existed.
    res.setHeader("Cache-Control", "public, max-age=15, must-revalidate");
    return res.json({
      date: `${manilaDay.getUTCFullYear()}-${pad(manilaDay.getUTCMonth() + 1)}-${pad(manilaDay.getUTCDate())}`,
      total_sales: Number(totalSales.toFixed(2)),
      orders: todayOrders.length,
      carts,
      weekly,
      asOf: new Date().toISOString(),
    });
  } catch (err) {
    return next(err);
  }
});

// GET /api/reports/daily?date=YYYY-MM-DD&code=CART-01&daysAgo=N
// All day boundaries are Asia/Manila (server runs on UTC in prod).
router.get("/reports/daily", requireAuth, async (req, res, next) => {
  try {
    const { date, code, daysAgo } = req.query;
    let day;
    let nextDay;
    if (date) {
      const range = manilaDayRange(String(date));
      if (!range) {
        return res.status(400).json({ error: "date must be YYYY-MM-DD" });
      }
      day = range.start;
      nextDay = range.end;
    } else if (daysAgo != null) {
      const n = Number(daysAgo);
      if (!Number.isInteger(n) || n < 0) {
        return res.status(400).json({ error: "daysAgo must be an integer >= 0" });
      }
      day = manilaDayStart(n);
      nextDay = new Date(day.getTime() + 24 * 60 * 60 * 1000);
    } else {
      day = manilaDayStart(0);
      nextDay = new Date(day.getTime() + 24 * 60 * 60 * 1000);
    }

    const where = { createdAt: { gte: day, lt: nextDay }, status: "PAID" };
    if (code) where.location = { code: String(code) };

    const orders = await prisma.order.findMany({
      where,
      include: { items: true },
    });

    const totalSales = orders.reduce((sum, o) => sum + o.total, 0);
    const itemCounts = new Map();
    for (const order of orders) {
      for (const item of order.items) {
        const key = `${item.productName}|${item.flavor ?? ""}`;
        const current = itemCounts.get(key) ?? { name: item.productName, flavor: item.flavor, qty: 0 };
        current.qty += item.qty;
        itemCounts.set(key, current);
      }
    }
    const topItems = [...itemCounts.values()].sort((a, b) => b.qty - a.qty).slice(0, 5);

    const pad = (n) => String(n).padStart(2, "0");
    const manilaDay = new Date(day.getTime() + 8 * 60 * 60 * 1000);
    return res.json({
      date: `${manilaDay.getUTCFullYear()}-${pad(manilaDay.getUTCMonth() + 1)}-${pad(manilaDay.getUTCDate())}`,
      location: code ?? "ALL",
      total_sales: totalSales,
      orders: orders.length,
      top_items: topItems,
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
