import { Router } from "express";
import { prisma } from "../prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();

// GET /api/devices - IoT node registry with last-seen heartbeat (OWNER only)
router.get("/devices", requireAuth, requireRole("OWNER"), async (_req, res, next) => {
  try {
    const devices = await prisma.device.findMany({
      include: { location: { select: { code: true, name: true } } },
      orderBy: { deviceId: "asc" },
    });
    return res.json({
      data: devices.map((d) => ({
        id: d.id,
        device_id: d.deviceId,
        cart: d.location?.code ?? "-",
        cart_name: d.location?.name ?? "",
        active: d.active,
        last_seen_at: d.lastSeenAt,
        online:
          d.lastSeenAt !== null &&
          Date.now() - new Date(d.lastSeenAt).getTime() < 5 * 60 * 1000,
      })),
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
