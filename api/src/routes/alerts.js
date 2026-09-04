import { Router } from "express";
import { prisma } from "../prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();

router.get("/alerts", requireAuth, async (req, res, next) => {
  try {
    const { unread_only } = req.query;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(Number(req.query.pageSize) || 10, 100);
    const where = unread_only === "true" ? { isRead: false } : {};
    const [total, alerts] = await Promise.all([
      prisma.alert.count({ where }),
      prisma.alert.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return res.json({
      data: alerts,
      meta: { total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    });
  } catch (err) {
    return next(err);
  }
});

router.patch("/alerts/read", requireAuth, requireRole("OWNER"), async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids.map(Number).filter((n) => Number.isInteger(n))
      : null;
    const where = { isRead: false };
    if (ids && ids.length > 0) where.id = { in: ids };
    const { count } = await prisma.alert.updateMany({ where, data: { isRead: true } });
    return res.json({ updated: count });
  } catch (err) {
    return next(err);
  }
});

router.patch("/alerts/:id/read", requireAuth, requireRole("OWNER"), async (req, res, next) => {
  try {
    const alert = await prisma.alert.update({
      where: { id: Number(req.params.id) },
      data: { isRead: true },
    });
    return res.json({ alert });
  } catch (err) {
    if (err.code === "P2025") {
      return res.status(404).json({ error: "Alert not found" });
    }
    return next(err);
  }
});

export default router;
