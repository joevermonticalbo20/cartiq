import { Router } from "express";
import { db as prisma } from "../firestore.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { emit } from "./events.js";

const router = Router();

export function stockStatus(stock, threshold) {
  if (stock <= threshold / 2) return "critical";
  if (stock <= threshold) return "low";
  return "ok";
}

function decorate(items) {
  return items.map((it) => ({
    ...it,
    status: stockStatus(it.stock, it.threshold),
  }));
}

// GET /api/inventory                -> every location, grouped
// GET /api/inventory?code=CART-01   -> one location
router.get("/inventory", requireAuth, async (req, res, next) => {
  try {
    const { code } = req.query;
    const locations = await prisma.location.findMany({
      where: code ? { code: String(code) } : {},
      include: { inventory: { orderBy: { name: "asc" } } },
      orderBy: { code: "asc" },
    });
    return res.json({
      locations: locations.map((loc) => ({
        id: loc.id,
        code: loc.code,
        name: loc.name,
        items: decorate(loc.inventory),
      })),
    });
  } catch (err) {
    return next(err);
  }
});

// POST /api/inventory/items - add a new stock row to a cart (any
// authenticated staff; the dashboard Add Item form is not role-gated, same
// as adjustments). The dashboard also sends `category`, which has no backing
// field and is intentionally ignored.
router.post("/inventory/items", requireAuth, async (req, res, next) => {
  try {
    const { locationCode, locationId, name, unit, stock, threshold, source } = req.body ?? {};
    if (locationId === undefined && (locationCode === undefined || locationCode === "")) {
      return res.status(400).json({ error: "locationCode or locationId is required" });
    }
    if (locationId !== undefined && !Number.isInteger(+locationId)) {
      return res.status(400).json({ error: "locationId must be an integer" });
    }
    const itemName = String(name ?? "").trim().slice(0, 120);
    if (!itemName) {
      return res.status(400).json({ error: "name is required" });
    }
    const unitStr = String(unit ?? "pcs").trim().slice(0, 20) || "pcs";
    const stockNum = stock === undefined || stock === "" ? 0 : +stock;
    const thresholdNum = threshold === undefined || threshold === "" ? 0 : +threshold;
    if (!Number.isFinite(stockNum) || stockNum < 0 || stockNum > 100000 || !Number.isFinite(thresholdNum) || thresholdNum < 0 || thresholdNum > 100000) {
      return res.status(400).json({ error: "stock and threshold must be 0-100000" });
    }
    const src = source === "SENSOR" ? "SENSOR" : "MANUAL";

    const location = await prisma.location.findFirst({
      where: locationId !== undefined ? { id: +locationId } : { code: String(locationCode) },
    });
    if (!location) return res.status(404).json({ error: "Location not found" });

    const existing = await prisma.inventoryItem.findMany({
      where: { locationId: location.id, name: itemName },
    });
    if (existing.length > 0) {
      return res.status(409).json({ error: `Item "${itemName}" already exists at ${location.code}` });
    }

    const created = await prisma.inventoryItem.create({
      data: {
        locationId: location.id,
        name: itemName,
        unit: unitStr,
        stock: stockNum,
        threshold: thresholdNum,
        source: src,
      },
    });
    return res.status(201).json({ item: decorate([created])[0], locationCode: location.code });
  } catch (err) {
    return next(err);
  }
});

router.patch("/inventory/items/:id", requireAuth, requireRole("OWNER"), async (req, res, next) => {
  try {
    const { threshold } = req.body ?? {};
    if (threshold === undefined || !Number.isFinite(+threshold) || +threshold < 0 || +threshold > 100000) {
      return res.status(400).json({ error: "threshold must be 0-100000" });
    }
    const item = await prisma.inventoryItem.findUnique({ where: { id: +req.params.id } });
    if (!item) return res.status(404).json({ error: "Inventory item not found" });
    const updated = await prisma.inventoryItem.update({
      where: { id: item.id },
      data: { threshold: +threshold },
    });
    return res.json({ item: decorate([updated])[0] });
  } catch (err) {
    return next(err);
  }
});

router.post("/inventory/adjustments", requireAuth, async (req, res, next) => {
  try {
    const { inventoryItemId, newStock, reason } = req.body ?? {};
    if (!Number.isInteger(+inventoryItemId) || !Number.isFinite(+newStock) || +newStock < 0 || +newStock > 100000) {
      return res.status(400).json({ error: "inventoryItemId and newStock 0-100000 are required" });
    }
    // Staff corrections need a reason (owner rows record it when given).
    // Every adjustment is audit-trailed with actor + before/after.
    if (req.user.role !== "OWNER" && !String(reason ?? "").trim()) {
      return res.status(400).json({ error: "reason is required for staff adjustments" });
    }
    const item = await prisma.inventoryItem.findUnique({ where: { id: +inventoryItemId } });
    if (!item) return res.status(404).json({ error: "Inventory item not found" });

    // Numeric id allocated up front: counter reads are illegal once the
    // transaction has staged its first write.
    const [adjustmentId] = await prisma.stockAdjustment.nextIds(1);
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.inventoryItem.update({
        where: { id: item.id },
        data: { stock: +newStock },
      });
      const adjustment = await tx.stockAdjustment.create({
        data: {
          id: adjustmentId,
          inventoryItemId: item.id,
          locationId: item.locationId,
          actorId: req.user.sub,
          before: item.stock,
          after: +newStock,
          reason: reason ? String(reason).slice(0, 500) : null,
        },
      });
      return { updated, adjustment };
    });
    const { updated, adjustment } = result;

    const crossed = updated.stock <= updated.threshold;
    if (crossed) {
      const alert = await prisma.alert.create({
        data: {
          type: "LOW_STOCK",
          message: `${item.name} @ manual adjustment set to ${updated.stock} ${item.unit} (threshold ${updated.threshold})`,
          payload: JSON.stringify({
            dedupeKey: `low:${item.locationId}:${item.id}:manual:${Date.now()}`,
            inventoryItemId: item.id,
            locationId: item.locationId,
            reason: reason ?? null,
          }),
        },
      });
      emit("alert:new", { id: alert.id, type: "LOW_STOCK", message: alert.message });
    }
    return res.json({
      item: decorate([updated])[0],
      adjustment: {
        id: adjustment.id,
        actorId: adjustment.actorId,
        before: adjustment.before,
        after: adjustment.after,
        reason: adjustment.reason,
      },
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
