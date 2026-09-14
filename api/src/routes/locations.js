import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { db as prisma } from "../firestore.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();

// Cart codes: CART-04, SM-MALL, etc. Uppercase enforced server-side.
const CODE_RE = /^[A-Z0-9-]{3,12}$/;

// Starter stock copied from the seed template for every new cart.
const INVENTORY_TEMPLATE = [
  { name: "LPG Tank", unit: "kg", stock: 11.0, threshold: 2.5, source: "SENSOR" },
  { name: "Cheese Powder", unit: "kg", stock: 3.0, threshold: 1.0, source: "SENSOR" },
  { name: "Sour Cream Powder", unit: "kg", stock: 2.0, threshold: 1.0, source: "MANUAL" },
  { name: "BBQ Powder", unit: "kg", stock: 2.0, threshold: 1.0, source: "MANUAL" },
  { name: "Fries (frozen packs)", unit: "packs", stock: 12, threshold: 4, source: "MANUAL" },
  { name: "Pouches", unit: "pcs", stock: 150, threshold: 50, source: "MANUAL" },
];

function countLetters(s) {
  const m = String(s ?? "").match(/\p{L}/gu);
  return m ? m.length : 0;
}

// GET /api/locations (OWNER) — every cart incl. INACTIVE, with item counts
// and node status. The POS catalog (/catalog) lists ACTIVE only.
router.get("/locations", requireAuth, requireRole("OWNER"), async (_req, res, next) => {
  try {
    const [locations, items, devices] = await Promise.all([
      prisma.location.findMany({ orderBy: { code: "asc" } }),
      prisma.inventoryItem.findMany(),
      prisma.device.findMany(),
    ]);
    const itemCount = new Map();
    for (const it of items) {
      itemCount.set(it.locationId, (itemCount.get(it.locationId) ?? 0) + 1);
    }
    const deviceByLoc = new Map(devices.map((d) => [d.locationId, d]));
    return res.json({
      data: locations.map((loc) => {
        const dev = deviceByLoc.get(loc.id) ?? null;
        return {
          id: loc.id,
          code: loc.code,
          name: loc.name,
          address: loc.address ?? null,
          status: loc.status ?? "ACTIVE",
          itemCount: itemCount.get(loc.id) ?? 0,
          device: dev
            ? {
              deviceId: dev.deviceId,
              active: dev.active,
              online:
                dev.lastSeenAt !== null &&
                Date.now() - new Date(dev.lastSeenAt).getTime() < 5 * 60 * 1000,
            }
            : null,
        };
      }),
    });
  } catch (err) {
    return next(err);
  }
});

// POST /api/locations (OWNER) — provision a cart: location row (+ optional
// starter inventory) + ESP32 device row. The plaintext device token is
// returned ONCE (never stored, never logged) for the one-shot UI display.
// Body: { code*, name*, address?, seedInventory? default true }
router.post("/locations", requireAuth, requireRole("OWNER"), async (req, res, next) => {
  try {
    const { code, name, address, seedInventory = true } = req.body ?? {};
    const cartCode = String(code ?? "").trim().toUpperCase();
    if (!CODE_RE.test(cartCode)) {
      return res.status(400).json({ error: "code must be 3-12 chars: A-Z, 0-9, dash (e.g. CART-04)" });
    }
    const cartName = String(name ?? "").trim();
    if (cartName.length < 2 || cartName.length > 120 || countLetters(cartName) < 2) {
      return res.status(400).json({ error: "name needs at least 2 letters (max 120 characters)" });
    }
    const exists = await prisma.location.findUnique({ where: { code: cartCode } });
    if (exists) return res.status(409).json({ error: `Cart "${cartCode}" already exists` });

    const deviceId = `esp32-${cartCode.toLowerCase()}`;
    const deviceExists = await prisma.device.findUnique({ where: { deviceId } });
    if (deviceExists) {
      return res.status(409).json({ error: `Device "${deviceId}" already exists` });
    }

    // Plaintext token lives only in this response. Hash before the txn.
    const deviceToken = `dev-${cartCode}-${crypto.randomBytes(4).toString("hex")}`;
    const tokenHash = await bcrypt.hash(deviceToken, 10);
    const rows = seedInventory === false ? [] : INVENTORY_TEMPLATE;

    const result = await prisma.runTransaction(async (tx) => {
      const alloc = await tx.allocIds({
        locations: 1,
        inventoryItems: rows.length,
        devices: 1,
      });
      const [locationId] = alloc.locations;
      const [deviceRowId] = alloc.devices;
      const itemIds = alloc.inventoryItems ?? [];
      const location = await tx.location.create({
        data: {
          id: locationId,
          code: cartCode,
          name: cartName,
          address: address ? String(address).slice(0, 200) : null,
          status: "ACTIVE",
        },
      });
      const items = [];
      for (let i = 0; i < rows.length; i++) {
        items.push(
          await tx.inventoryItem.create({
            data: { id: itemIds[i], locationId, ...rows[i] },
          })
        );
      }
      const device = await tx.device.create({
        data: { id: deviceRowId, deviceId, locationId, tokenHash, active: true },
      });
      return { location, items, device };
    });

    return res.status(201).json({
      location: result.location,
      items: result.items,
      device: { deviceId: result.device.deviceId, active: result.device.active },
      deviceToken,
    });
  } catch (err) {
    return next(err);
  }
});

// PATCH /api/locations/:id (OWNER) — rename / set address / activate.
// Code is immutable (devices, payloads, and history reference it).
// Body: { name?, address?, status?: "ACTIVE"|"INACTIVE" }
router.patch("/locations/:id", requireAuth, requireRole("OWNER"), async (req, res, next) => {
  try {
    const { name, address, status } = req.body ?? {};
    if (name === undefined && address === undefined && status === undefined) {
      return res.status(400).json({ error: "provide name, address, or status" });
    }
    const existing = await prisma.location.findUnique({ where: { id: Number(req.params.id) } });
    if (!existing) return res.status(404).json({ error: "Location not found" });
    const data = {};
    if (name !== undefined) {
      const cartName = String(name).trim();
      if (cartName.length < 2 || cartName.length > 120 || countLetters(cartName) < 2) {
        return res.status(400).json({ error: "name needs at least 2 letters (max 120 characters)" });
      }
      data.name = cartName;
    }
    if (address !== undefined) {
      data.address = address === null || address === "" ? null : String(address).slice(0, 200);
    }
    if (status !== undefined) {
      const st = String(status).toUpperCase();
      if (!["ACTIVE", "INACTIVE"].includes(st)) {
        return res.status(400).json({ error: 'status must be "ACTIVE" or "INACTIVE"' });
      }
      data.status = st;
    }
    const location = await prisma.location.update({ where: { id: existing.id }, data });
    return res.json({ location });
  } catch (err) {
    return next(err);
  }
});

export default router;
