import { Router } from "express";
import { prisma } from "../prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { applyStockChange } from "../services/inventory_rules.js";
import { emit } from "./events.js";

const router = Router();

const randomRef = () =>
  globalThis.crypto?.randomUUID?.() ??
  `ref-${Date.now()}-${Math.random().toString(16).slice(2)}`;

router.post("/orders", requireAuth, async (req, res, next) => {
  try {
    const { clientRef, locationCode, locationId, items, total } = req.body ?? {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items must be a non-empty array" });
    }
    for (const it of items) {
      if (!it.productName || !Number.isFinite(+it.qty) || +it.qty <= 0 ||
          !Number.isFinite(+it.unitPrice)) {
        return res.status(400).json({
          error: "each item needs productName, qty > 0 and unitPrice",
        });
      }
    }

    const location = await prisma.location.findFirst({
      where: locationId !== undefined ? { id: +locationId } : { code: locationCode },
    });
    if (!location) return res.status(404).json({ error: "Location not found" });

    const ref = clientRef ? String(clientRef) : randomRef();

    // Idempotent replay handling: the same offline-queued sale may arrive twice.
    const existing = await prisma.order.findUnique({
      where: { clientRef: ref },
      include: { items: true },
    });
    if (existing) {
      return res.json({ duplicate: true, order: existing, warnings: [] });
    }

    const result = await prisma.$transaction(async (tx) => {
      const orderTotal = Number.isFinite(+total)
        ? +total
        : items.reduce((sum, it) => sum + +it.qty * +it.unitPrice, 0);

      const order = await tx.order.create({
        data: {
          clientRef: ref,
          locationId: location.id,
          staffId: req.user.sub,
          total: orderTotal,
          status: "PAID",
          items: {
            create: items.map((it) => ({
              productName: it.productName,
              flavor: it.flavor ?? null,
              qty: Math.round(+it.qty),
              unitPrice: +it.unitPrice,
            })),
          },
        },
        include: { items: true },
      });

      // Automatic ingredient deduction. Flavor-specific recipe rows win over
      // the generic ("") row for the same inventory item.
      const warnings = [];
      for (const it of order.items) {
        const flavorKey = it.flavor ?? "";
        const maps = await tx.ingredientMap.findMany({
          where: { productName: it.productName, flavor: { in: [flavorKey, ""] } },
        });
        const byItem = new Map();
        for (const m of maps) {
          const current = byItem.get(m.itemName);
          if (!current || (m.flavor === flavorKey && current.flavor !== flavorKey)) {
            byItem.set(m.itemName, m);
          }
        }
        for (const map of byItem.values()) {
          const inv = await tx.inventoryItem.findFirst({
            where: { locationId: location.id, name: map.itemName },
          });
          if (!inv) {
            warnings.push(`no inventory row "${map.itemName}" at ${location.code}`);
            continue;
          }
          const newStock = Math.max(0, inv.stock - map.amountPerUnit * it.qty);
          await applyStockChange(tx, { inv, newStock, location });
        }
      }
      return { order, warnings };
    });

    emit("order:new", {
      id: result.order.id,
      total: result.order.total,
      locationCode: location.code,
      itemCount: result.order.items.length,
      staffName: req.user?.name,
    });

    return res.status(201).json({ duplicate: false, ...result, locationCode: location.code });
  } catch (err) {
    return next(err);
  }
});

router.get("/orders", requireAuth, async (req, res, next) => {
  try {
    const { location_code, date } = req.query;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(Number(req.query.pageSize) || 10, 100);
    const where = {};
    if (location_code) {
      const loc = await prisma.location.findUnique({ where: { code: String(location_code) } });
      if (!loc) return res.json({ data: [], meta: emptyMeta(page, pageSize) });
      where.locationId = loc.id;
    }
    if (date) {
      const start = new Date(`${date}T00:00:00`);
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      where.createdAt = { gte: start, lt: end };
    }
    const [total, orders] = await Promise.all([
      prisma.order.count({ where }),
      prisma.order.findMany({
        where,
        include: {
          items: true,
          location: { select: { code: true, name: true } },
          staff: { select: { name: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return res.json({
      data: orders,
      meta: { total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    });
  } catch (err) {
    return next(err);
  }
});

function emptyMeta(page, pageSize) {
  return { total: 0, page, pageSize, totalPages: 1 };
}

export default router;
