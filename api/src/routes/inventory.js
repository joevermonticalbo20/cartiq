import { Router } from "express";
import { db as prisma } from "../firestore.js";
import { requireAuth, requireRole, assertOwnLocation } from "../middleware/auth.js";
import { emit } from "./events.js";
import {
  restockRequestKey,
  shouldCreateRestockRequest,
} from "../services/low_stock_alert.js";

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
    isOutOfStock: Number(it.stock) <= 0,
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

router.get("/inventory/restock-requests", requireAuth, async (req, res, next) => {
  try {
    const { code } = req.query;
    let locationId;
    if (code) {
      const location = await prisma.location.findFirst({
        where: { code: String(code) },
      });
      if (!location) return res.status(404).json({ error: "Location not found" });
      assertOwnLocation(req, location.id);
      locationId = location.id;
    } else if (req.user.role !== "OWNER") {
      locationId = req.user.locationId;
      if (locationId == null) {
        return res.status(403).json({ error: "Forbidden: no cart assigned to this account" });
      }
    }
    const requests = await Promise.all(
      ["pending", "acknowledged"].map((status) =>
        prisma.alert.findMany({
          where: {
            type: "RESTOCK_REQUEST",
            status,
            ...(locationId != null ? { locationId } : {}),
          },
          orderBy: { createdAt: "desc" },
          take: 200,
          nocache: true,
        }),
      ),
    );
    return res.json({
      data: requests.flat().sort((a, b) =>
        new Date(b.createdAt) - new Date(a.createdAt),
      ).slice(0, 200),
    });
  } catch (err) {
    return next(err);
  }
});

// POST /api/inventory/restock-request
// { ingredientId } creates one request; { allLowStock: true } requests every
// low/out-of-stock item for the signed-in cart. OWNERs may optionally pass
// locationCode to choose a cart.
router.post("/inventory/restock-request", requireAuth, async (req, res, next) => {
  try {
    const {
      ingredientId,
      allLowStock = false,
      locationCode,
      urgency = "normal",
      notes,
    } = req.body ?? {};
    if (!["normal", "urgent", "critical"].includes(urgency)) {
      return res.status(400).json({ error: "urgency must be normal, urgent, or critical" });
    }
    if (typeof notes !== "undefined" &&
        (typeof notes !== "string" || notes.length > 500)) {
      return res.status(400).json({ error: "notes must be a string of at most 500 characters" });
    }
    if (typeof allLowStock !== "boolean" ||
        (allLowStock
          ? ingredientId !== undefined
          : ingredientId === undefined || ingredientId === null ||
            ingredientId === "" || !Number.isInteger(Number(ingredientId)))) {
      return res.status(400).json({
        error: "provide ingredientId for one request or allLowStock: true for a batch",
      });
    }

    let location;
    if (locationCode != null && req.user.role === "OWNER") {
      location = await prisma.location.findFirst({ where: { code: String(locationCode) } });
    } else if (req.user.locationId != null) {
      location = await prisma.location.findUnique({ where: { id: req.user.locationId } });
    } else if (req.user.role === "OWNER" && allLowStock) {
      location = await prisma.location.findFirst({
        where: { status: "ACTIVE" },
        orderBy: { code: "asc" },
      });
    }
    if (!location) return res.status(404).json({ error: "Location not found" });
    assertOwnLocation(req, location.id);

    const inventory = allLowStock
      ? await prisma.inventoryItem.findMany({ where: { locationId: location.id } })
      : [await prisma.inventoryItem.findUnique({ where: { id: +ingredientId } })];
    if (!allLowStock && !inventory[0]) {
      return res.status(404).json({ error: "Inventory item not found" });
    }
    const candidates = inventory.filter((item) =>
      item && item.locationId === location.id &&
      (allLowStock ? Number(item.stock) <= Number(item.threshold) : true),
    );
    if (!allLowStock && candidates.length === 0) {
      return res.status(404).json({ error: "Inventory item not found at this cart" });
    }
    if (allLowStock && candidates.length === 0) {
      return res.status(400).json({ error: "No low-stock ingredients to request" });
    }

    const known = new Set();
    const created = [];
    const active = [];
    for (const item of candidates) {
      const key = restockRequestKey(location.id, item.id);
      // ONE query, reused for both decisions: "should a new request be opened?"
      // and "which existing request is still active?". This used to run the
      // same query twice - once inside the helper and once again right after -
      // which doubled the reads on a route the POS app calls often.
      let existing = [];
      const shouldCreate = await shouldCreateRestockRequest({
        locationId: location.id,
        inventoryItemId: item.id,
        known,
        lookup: async (restockKey) => {
          existing = await prisma.alert.findMany({
            where: { restockKey },
            orderBy: { createdAt: "desc" },
            take: 10,
            nocache: true,
          });
          return existing;
        },
      });
      if (!shouldCreate) {
        active.push(existing.find((request) =>
          request.status === "pending" || request.status === "acknowledged",
        ));
        continue;
      }
      const message = `Restock requested: ${item.name} @ ${location.code}`;
      const request = await prisma.alert.create({
        data: {
          type: "RESTOCK_REQUEST",
          message,
          restockKey: key,
          ingredientId: item.id,
          ingredientName: item.name,
          locationId: location.id,
          locationCode: location.code,
          urgency,
          notes: String(notes ?? "").trim() || null,
          requestedBy: req.user.sub,
          requestedByName: req.user.name ?? req.user.username ?? "Staff",
          status: "pending",
          isRead: false,
          payload: JSON.stringify({
            ingredientId: item.id,
            ingredientName: item.name,
            locationId: location.id,
            locationCode: location.code,
            urgency,
            notes: String(notes ?? "").trim() || null,
            requestedBy: req.user.sub,
            requestedByName: req.user.name ?? req.user.username ?? "Staff",
            status: "pending",
          }),
        },
      });
      created.push(request);
      emit("restock-request:new", {
        ...request,
        ingredientName: item.name,
        locationCode: location.code,
      });
    }
    return res.status(created.length > 0 ? 201 : 200).json({
      data: created,
      activeRequests: [...active.filter(Boolean), ...created],
      skipped: candidates.length - created.length - active.length,
    });
  } catch (err) {
    return next(err);
  }
});

// GET /api/inventory/names — distinct stock item names (+ most common unit)
// across all carts. Feeds the Products recipe picker so recipe rows use
// exact names — deduction matches map.itemName to inventory rows by exact
// name, so a typo means the sale warns instead of deducting.
router.get("/inventory/names", requireAuth, async (_req, res, next) => {
  try {
    const rows = await prisma.inventoryItem.findMany({ select: { name: true, unit: true } });
    const byName = new Map();
    for (const r of rows) {
      const name = String(r.name ?? "").trim();
      if (!name) continue;
      const hit = byName.get(name) ?? { name, units: new Map() };
      hit.units.set(r.unit, (hit.units.get(r.unit) ?? 0) + 1);
      byName.set(name, hit);
    }
    return res.json({
      data: [...byName.values()]
        .map(({ name, units }) => ({
          name,
          unit: [...units.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
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

// DELETE /api/inventory/items/:id (OWNER) — blocked while recipes reference
// the name or the row is sensor-managed; otherwise removes the row.
// Mirrors the products delete guard (products.js) so history is never orphaned.
router.delete("/inventory/items/:id", requireAuth, requireRole("OWNER"), async (req, res, next) => {
  try {
    const existing = await prisma.inventoryItem.findUnique({ where: { id: Number(req.params.id) } });
    if (!existing) return res.status(404).json({ error: "Inventory item not found" });
    if (existing.source === "SENSOR") {
      return res.status(409).json({
        error: `Cannot delete "${existing.name}": sensor-managed stock row`,
      });
    }
    const maps = await prisma.ingredientMap.findMany({ where: { itemName: existing.name } });
    if (maps.length > 0) {
      return res.status(409).json({
        error: `Cannot delete "${existing.name}": referenced by ${maps.length} recipe row(s)`,
        recipeRows: maps.length,
      });
    }
    await prisma.inventoryItem.delete({ where: { id: existing.id } });
    return res.json({ deleted: true });
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "Inventory item not found" });
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

    const result = await prisma.$transaction(async (tx) => {
      // Re-read INSIDE the txn: the outside read can be stale when a POS
      // sale or IoT reading deducts stock concurrently. Firestore optimistic
      // concurrency retries the txn on conflict, so `before` below is the
      // true pre-write stock and no deduction is silently clobbered.
      const fresh = await tx.inventoryItem.findUnique({ where: { id: item.id } });
      if (!fresh) throw Object.assign(new Error("Inventory item not found"), { status: 404 });
      // STAFF may only adjust their assigned cart's stock (OWNERs bypass).
      // Checked here — after the fresh read, before any write.
      assertOwnLocation(req, fresh.locationId);
      // Allocate after all reads, before writes (counter reads are illegal
      // once the transaction has staged its first write).
      const [adjustmentId] = await tx.stockAdjustment.nextIds(1);
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
          before: fresh.stock,
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
