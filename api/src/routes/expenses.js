import { Router } from "express";
import { prisma } from "../prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/auth.js";

const router = Router();

export const EXPENSE_CATEGORIES = [
  "Supplies",
  "LPG/Gas",
  "Maintenance",
  "Fees/Rent",
  "Other",
];

function decorate(expense) {
  return {
    ...expense,
    lines: expense.lines ? JSON.parse(expense.lines) : null,
  };
}

// POST /api/expenses - record an expense (OCR-confirmed or manual)
router.post("/expenses", requireAuth, async (req, res, next) => {
  try {
    const { vendor, locationCode, amount, date, source, note, lines, category } =
      req.body ?? {};
    if (!vendor || !Number.isFinite(+amount) || +amount <= 0) {
      return res.status(400).json({ error: "vendor and positive amount are required" });
    }
    const src = source === "OCR" ? "OCR" : "MANUAL";
    const cat = category ?? "Supplies";
    if (!EXPENSE_CATEGORIES.includes(cat)) {
      return res.status(400).json({
        error: `category must be one of: ${EXPENSE_CATEGORIES.join(", ")}`,
      });
    }

    let locationId = null;
    if (locationCode) {
      const loc = await prisma.location.findUnique({ where: { code: String(locationCode) } });
      if (!loc) return res.status(404).json({ error: "Location not found" });
      locationId = loc.id;
    }

    const expense = await prisma.expense.create({
      data: {
        vendor: String(vendor).slice(0, 120),
        locationId,
        amount: +amount,
        date: date ? new Date(date) : new Date(),
        source: src,
        category: cat,
        note: note ? String(note).slice(0, 500) : null,
        lines: Array.isArray(lines) ? JSON.stringify(lines).slice(0, 4000) : null,
      },
      include: { location: { select: { code: true, name: true } } },
    });

    return res.status(201).json({ expense: decorate(expense) });
  } catch (err) {
    return next(err);
  }
});

// GET /api/expenses?code=&month=YYYY-MM&category=&page=&pageSize=
router.get("/expenses", requireAuth, async (req, res, next) => {
  try {
    const { code, month, category } = req.query;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(Number(req.query.pageSize) || 10, 100);
    const where = {};
    if (code) where.location = { code: String(code) };
    if (category && EXPENSE_CATEGORIES.includes(String(category))) {
      where.category = String(category);
    }
    if (month && /^\d{4}-\d{2}$/.test(String(month))) {
      const start = new Date(`${month}-01T00:00:00`);
      const end = new Date(start);
      end.setMonth(end.getMonth() + 1);
      where.date = { gte: start, lt: end };
    }

    const [total, expenses, aggregate] = await Promise.all([
      prisma.expense.count({ where }),
      prisma.expense.findMany({
        where,
        include: { location: { select: { code: true, name: true } } },
        orderBy: { date: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.expense.aggregate({ where, _sum: { amount: true }, _count: true }),
    ]);

    // breakdowns over the whole filtered period (ignoring the category filter
    // so the category chart always shows the full picture)
    const breakdownWhere = { ...where };
    delete breakdownWhere.category;
    const all = await prisma.expense.findMany({
      where: breakdownWhere,
      select: { vendor: true, amount: true, category: true },
    });
    const byVendorMap = new Map();
    const byCategoryMap = new Map();
    for (const e of all) {
      byVendorMap.set(e.vendor, (byVendorMap.get(e.vendor) ?? 0) + e.amount);
      byCategoryMap.set(e.category, (byCategoryMap.get(e.category) ?? 0) + e.amount);
    }
    const byVendor = [...byVendorMap.entries()]
      .map(([vendor, amt]) => ({ vendor, total: Number(amt.toFixed(2)) }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 8);
    const byCategory = EXPENSE_CATEGORIES.map((cat) => ({
      category: cat,
      total: Number((byCategoryMap.get(cat) ?? 0).toFixed(2)),
    }));

    return res.json({
      data: expenses.map(decorate),
      meta: { total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
      totals: {
        count: aggregate._count,
        total_amount: Number((aggregate._sum.amount ?? 0).toFixed(2)),
      },
      by_vendor: byVendor,
      by_category: byCategory,
      categories: EXPENSE_CATEGORIES,
    });
  } catch (err) {
    return next(err);
  }
});

// PATCH /api/expenses/:id - correct OCR-parsed fields after review
router.patch("/expenses/:id", requireAuth, async (req, res, next) => {
  try {
    const { vendor, amount, date, note, category } = req.body ?? {};
    const data = {};
    if (vendor !== undefined) data.vendor = String(vendor).slice(0, 120);
    if (category !== undefined) {
      if (!EXPENSE_CATEGORIES.includes(category)) {
        return res.status(400).json({ error: `category must be one of: ${EXPENSE_CATEGORIES.join(", ")}` });
      }
      data.category = category;
    }
    if (amount !== undefined) {
      if (!Number.isFinite(+amount) || +amount <= 0) {
        return res.status(400).json({ error: "amount must be a positive number" });
      }
      data.amount = +amount;
    }
    if (date !== undefined) data.date = new Date(date);
    if (note !== undefined) data.note = String(note).slice(0, 500);

    const existing = await prisma.expense.findUnique({ where: { id: Number(req.params.id) } });
    if (!existing) return res.status(404).json({ error: "Expense not found" });

    const updated = await prisma.expense.update({
      where: { id: existing.id },
      data,
      include: { location: { select: { code: true, name: true } } },
    });
    return res.json({ expense: decorate(updated) });
  } catch (err) {
    return next(err);
  }
});

// DELETE /api/expenses/:id - owner only
router.delete("/expenses/:id", requireAuth, requireRole("OWNER"), async (req, res, next) => {
  try {
    await prisma.expense.delete({ where: { id: Number(req.params.id) } });
    return res.json({ deleted: true });
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "Expense not found" });
    return next(err);
  }
});

export default router;
