import { Router } from "express";
import { db as prisma } from "../firestore.js";
import { requireAuth } from "../middleware/auth.js";
import { manilaDayRange, manilaDayStart } from "../services/timezone.js";

const router = Router();

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
