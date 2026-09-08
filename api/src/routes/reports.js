import { Router } from "express";
import { prisma } from "../prisma.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

// GET /api/reports/daily?date=YYYY-MM-DD&code=CART-01&daysAgo=N
router.get("/reports/daily", requireAuth, async (req, res, next) => {
  try {
    const { date, code, daysAgo } = req.query;
    let day;
    if (date) {
      day = new Date(`${date}T00:00:00`);
      if (!Number.isFinite(day.getTime())) {
        return res.status(400).json({ error: "date must be YYYY-MM-DD" });
      }
    } else if (daysAgo != null) {
      const n = Number(daysAgo);
      if (!Number.isInteger(n) || n < 0) {
        return res.status(400).json({ error: "daysAgo must be an integer >= 0" });
      }
      day = new Date();
      day.setDate(day.getDate() - n);
    } else {
      day = new Date();
    }
    day.setHours(0, 0, 0, 0);
    const nextDay = new Date(day);
    nextDay.setDate(nextDay.getDate() + 1);

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
    return res.json({
      date: `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`,
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
