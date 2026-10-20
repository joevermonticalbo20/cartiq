import { Router } from "express";
import { db as prisma } from "../firestore.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { emit } from "./events.js";

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

router.get(
  "/alerts/restock-requests",
  requireAuth,
  requireRole("OWNER"),
  async (req, res, next) => {
    try {
      const where = { type: "RESTOCK_REQUEST" };
      if (req.query.code) {
        const location = await prisma.location.findFirst({
          where: { code: String(req.query.code) },
        });
        if (!location) return res.status(404).json({ error: "Location not found" });
        where.locationId = location.id;
      }
      const activeOnly = req.query.active !== "false";
      const statuses = activeOnly ? ["pending", "acknowledged"] : [null];
      const requests = await Promise.all(statuses.map((status) =>
        prisma.alert.findMany({
          where: { ...where, ...(status ? { status } : {}) },
          orderBy: { createdAt: "desc" },
          take: 200,
          nocache: true,
        }),
      ));
      return res.json({
        data: requests.flat().sort((a, b) =>
          new Date(b.createdAt) - new Date(a.createdAt),
        ).slice(0, 200),
      });
    } catch (err) {
      return next(err);
    }
  },
);

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

// PATCH /alerts/:id/ack - staff acknowledgement. Any authenticated user may
// acknowledge (detected -> acknowledged), but only OWNER resolves via
// isRead (acknowledged -> resolved). Never deletes.
router.patch("/alerts/:id/ack", requireAuth, async (req, res, next) => {
  try {
    const alert = await prisma.alert.update({
      where: { id: Number(req.params.id) },
      data: {
        ackedBy: req.user.sub,
        ackedAt: new Date(),
        ackedByName: req.user.name ?? req.user.username,
      },
    });
    return res.json({ alert });
  } catch (err) {
    if (err.code === "P2025") {
      return res.status(404).json({ error: "Alert not found" });
    }
    return next(err);
  }
});

router.patch(
  "/alerts/:id/restock-status",
  requireAuth,
  requireRole("OWNER"),
  async (req, res, next) => {
    try {
      const { status, resolution } = req.body ?? {};
      if (!["acknowledged", "fulfilled"].includes(status)) {
        return res.status(400).json({
          error: "status must be acknowledged or fulfilled",
        });
      }
      if (resolution !== undefined &&
          !["restocked", "dismissed"].includes(resolution)) {
        return res.status(400).json({
          error: "resolution must be restocked or dismissed",
        });
      }
      if (status !== "fulfilled" && resolution !== undefined) {
        return res.status(400).json({
          error: "resolution is only valid when status is fulfilled",
        });
      }
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        return res.status(404).json({ error: "Restock request not found" });
      }
      const existing = await prisma.alert.findUnique({
        where: { id },
      });
      if (!existing || existing.type !== "RESTOCK_REQUEST") {
        return res.status(404).json({ error: "Restock request not found" });
      }
      if (!["pending", "acknowledged"].includes(existing.status)) {
        return res.status(409).json({ error: "Restock request is already resolved" });
      }
      const alert = await prisma.alert.update({
        where: { id: existing.id },
        data: {
          status,
          ...(status === "fulfilled"
            ? {
                resolution: resolution ?? "restocked",
                resolvedBy: req.user.sub,
                resolvedAt: new Date(),
              }
            : {}),
          ...(status === "acknowledged"
            ? {
                ackedBy: req.user.sub,
                ackedAt: new Date(),
                ackedByName: req.user.name ?? req.user.username,
              }
            : {}),
        },
      });
      emit("restock-request:updated", alert);
      return res.json({ alert });
    } catch (err) {
      if (err.code === "P2025") {
        return res.status(404).json({ error: "Restock request not found" });
      }
      return next(err);
    }
  },
);

export default router;
