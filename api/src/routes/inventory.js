import { Router } from "express";
import { prisma } from "../prisma.js";
import { requireAuth } from "../middleware/auth.js";
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

router.patch("/inventory/items/:id", requireAuth, async (req, res, next) => {
  try {
    const { threshold } = req.body ?? {};
    if (threshold === undefined || !Number.isFinite(+threshold) || +threshold < 0) {
      return res.status(400).json({ error: "non-negative threshold is required" });
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
    if (!Number.isInteger(+inventoryItemId) || !Number.isFinite(+newStock) || +newStock < 0) {
      return res.status(400).json({ error: "inventoryItemId and non-negative newStock are required" });
    }
    const item = await prisma.inventoryItem.findUnique({ where: { id: +inventoryItemId } });
    if (!item) return res.status(404).json({ error: "Inventory item not found" });

    const updated = await prisma.inventoryItem.update({
      where: { id: item.id },
      data: { stock: +newStock },
    });

    const crossed = updated.stock <= updated.threshold;
    if (crossed) {
      const alert = await prisma.alert.create({
        data: {
          type: "LOW_STOCK",
          message: `${item.name} @ manual adjustment set to ${updated.stock} ${item.unit} (threshold ${updated.threshold})`,
          payload: JSON.stringify({ inventoryItemId: item.id, reason: reason ?? null }),
        },
      });
      emit("alert:new", { id: alert.id, type: "LOW_STOCK", message: alert.message });
    }
    return res.json({ item: decorate([updated])[0] });
  } catch (err) {
    return next(err);
  }
});

export default router;
