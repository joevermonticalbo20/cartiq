import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { db as prisma } from "../firestore.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{3,40}$/;

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

// POST /api/devices (OWNER) — register a standalone node. The plaintext
// token is returned ONCE (stored bcrypt-hashed); unassigned nodes 403 on
// readings/shifts until a cart is assigned via PATCH.
router.post("/devices", requireAuth, requireRole("OWNER"), async (req, res, next) => {
  try {
    const { deviceId, cart } = req.body ?? {};
    const cleanId = String(deviceId ?? "").trim();
    if (!DEVICE_ID_RE.test(cleanId)) {
      return res.status(400).json({ error: "deviceId must be 3-40 chars: letters, digits, _ or -" });
    }
    const exists = await prisma.device.findUnique({ where: { deviceId: cleanId } });
    if (exists) return res.status(409).json({ error: `Device "${cleanId}" already exists` });
    let locationId = null;
    if (cart) {
      const loc = await prisma.location.findUnique({ where: { code: String(cart) } });
      if (!loc) return res.status(404).json({ error: "Location not found" });
      locationId = loc.id;
    }
    // Plaintext token lives only in this response. Hash before create.
    const deviceToken = `dev-${crypto.randomBytes(8).toString("hex")}`;
    const tokenHash = await bcrypt.hash(deviceToken, 10);
    const device = await prisma.device.create({
      data: { deviceId: cleanId, locationId, tokenHash, active: true },
    });
    return res.status(201).json({
      device: { id: device.id, deviceId: device.deviceId, active: device.active },
      deviceToken,
    });
  } catch (err) {
    if (err.code === "P2002") return res.status(409).json({ error: "Device ID already exists" });
    return next(err);
  }
});

// PATCH /api/devices/:id (OWNER) — reassign cart and/or toggle active.
router.patch("/devices/:id", requireAuth, requireRole("OWNER"), async (req, res, next) => {
  try {
    const { cart, active } = req.body ?? {};
    const device = await prisma.device.findUnique({ where: { id: Number(req.params.id) } });
    if (!device) return res.status(404).json({ error: "Device not found" });
    const data = {};
    if (cart !== undefined) {
      if (cart === null || cart === "") {
        data.locationId = null;
      } else {
        const loc = await prisma.location.findUnique({ where: { code: String(cart) } });
        if (!loc) return res.status(404).json({ error: "Location not found" });
        data.locationId = loc.id;
      }
    }
    if (active !== undefined) data.active = Boolean(active);
    const updated = await prisma.device.update({ where: { id: device.id }, data });
    return res.json({ device: { id: updated.id, deviceId: updated.deviceId, active: updated.active } });
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "Device not found" });
    return next(err);
  }
});

// DELETE /api/devices/:id (OWNER) — remove the node. History rows keep the
// deviceId string (no FK), so readings/shifts history is preserved.
router.delete("/devices/:id", requireAuth, requireRole("OWNER"), async (req, res, next) => {
  try {
    const device = await prisma.device.findUnique({ where: { id: Number(req.params.id) } });
    if (!device) return res.status(404).json({ error: "Device not found" });
    await prisma.device.delete({ where: { id: device.id } });
    return res.json({ deleted: true });
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "Device not found" });
    return next(err);
  }
});

export default router;
