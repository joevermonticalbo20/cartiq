import { Router } from "express";
import { db as prisma } from "../firestore.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { fmtStock, oversellShortage } from "../services/inventory_rules.js";
import { emit } from "./events.js";

const router = Router();

const randomRef = () =>
  globalThis.crypto?.randomUUID?.() ??
  `ref-${Date.now()}-${Math.random().toString(16).slice(2)}`;

router.post("/orders", requireAuth, async (req, res, next) => {
  try {
    // Note: client-supplied `total` is intentionally ignored - the server
    // recomputes it from items (see below).
    const { clientRef, locationCode, locationId, items, paymentMethod } = req.body ?? {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items must be a non-empty array" });
    }
    for (const it of items) {
      const qty = +it.qty;
      const price = +it.unitPrice;
      if (typeof it.productName !== "string" || !it.productName.trim() ||
          !Number.isInteger(qty) || qty < 1 ||
          !Number.isFinite(price) || price < 0) {
        return res.status(400).json({
          error: "each item needs a productName, an integer qty >= 1 and a unitPrice >= 0",
        });
      }
    }

    if (locationId === undefined && (locationCode === undefined || locationCode === "")) {
      return res.status(400).json({ error: "locationCode or locationId is required" });
    }
    if (locationId !== undefined && !Number.isInteger(+locationId)) {
      return res.status(400).json({ error: "locationId must be an integer" });
    }
    if (clientRef !== undefined && String(clientRef).length > 200) {
      return res.status(400).json({ error: "clientRef is too long (max 200 chars)" });
    }
    const PAYMENT_METHODS = ["CASH", "GCASH", "CARD"];
    const payMethod =
      paymentMethod === undefined || paymentMethod === null || paymentMethod === ""
        ? null
        : String(paymentMethod).toUpperCase();
    if (payMethod !== null && !PAYMENT_METHODS.includes(payMethod)) {
      return res.status(400).json({ error: "paymentMethod must be one of: CASH, GCASH, CARD" });
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

    let result;
    try {
      // Firestore transactions require ALL reads before ALL writes, so this
      // runs as read phase (guard + recipes + stock + alerts) then write
      // phase (counter + guard + order + stock + alerts). Same validation,
      // same warnings/alert texts, same response shapes as before.
      // Idempotency is atomic via the orderRefs/{clientRef} guard doc: the
      // pre-check above is the fast path, the guard wins any same-ref race.
      const outcome = await prisma.runTransaction(async (tx) => {
        // ---- READ PHASE ----
        const guard = await tx.getDoc("orderRefs", ref);
        if (guard) return { dup: true };
        const [maps, invRows, unreadAlerts] = await Promise.all([
          tx.ingredientMap.findMany(),
          tx.inventoryItem.findMany({ where: { locationId: location.id } }),
          tx.alert.findMany({ where: { type: "LOW_STOCK", isRead: false } }),
        ]);
        const invByName = new Map(invRows.map((r) => [r.name, r]));

        // ---- COMPUTE PHASE (pure; mirrors the original per-item loop) ----
        // Server is the source of truth for the total - never trust the client.
        const orderTotal = items.reduce((sum, it) => sum + +it.qty * +it.unitPrice, 0);
        const itemRows = items.map((it) => ({
          productName: String(it.productName).trim().slice(0, 120),
          flavor: it.flavor == null ? null : String(it.flavor).slice(0, 80),
          qty: Math.trunc(+it.qty),
          unitPrice: +it.unitPrice,
        }));
        const warnings = [];
        const stockWrites = new Map(); // invId -> { inv, newStock }
        const createdNeedles = new Set();
        const newAlerts = [];
        for (const row of itemRows) {
          const flavorKey = row.flavor ?? "";
          const byItem = new Map();
          for (const m of maps) {
            if (m.productName !== row.productName) continue;
            if (m.flavor !== flavorKey && m.flavor !== "") continue;
            const current = byItem.get(m.itemName);
            if (!current || (m.flavor === flavorKey && current.flavor !== flavorKey)) {
              byItem.set(m.itemName, m);
            }
          }
          for (const map of byItem.values()) {
            const inv = invByName.get(map.itemName);
            if (!inv) {
              warnings.push(`no inventory row "${map.itemName}" at ${location.code}`);
              continue;
            }
            const base = stockWrites.has(inv.id) ? stockWrites.get(inv.id).newStock : inv.stock;
            const deduction = map.amountPerUnit * row.qty;
            const newStock = Math.max(0, base - deduction);
            const shortage = oversellShortage(base, map.amountPerUnit, row.qty);
            if (shortage > 0) {
              warnings.push(
                `OVERSOLD "${map.itemName}" at ${location.code}: requested ${fmtStock(deduction)} ${inv.unit}, had ${fmtStock(base)}, short ${fmtStock(shortage)}`
              );
            }
            // applyStockChange parity: alert only on threshold CROSSING.
            const crossed = base > inv.threshold && newStock <= inv.threshold;
            stockWrites.set(inv.id, { inv, newStock });
            if (crossed) {
              const needle = `${inv.name} @ ${location.code}`;
              const dup =
                createdNeedles.has(needle) ||
                unreadAlerts.some((a) => (a.message ?? "").includes(needle));
              if (!dup) {
                createdNeedles.add(needle);
                newAlerts.push({
                  type: "LOW_STOCK",
                  message: `${needle} dropped below threshold (${newStock} ${inv.unit} left)`,
                  payload: JSON.stringify({
                    inventoryItemId: inv.id,
                    stock: newStock,
                    threshold: inv.threshold,
                    unit: inv.unit,
                  }),
                });
              }
            }
          }
        }

        // ---- ID ALLOCATION (last reads of the transaction) ----
        const alloc = await tx.allocIds({
          orders: 1 + itemRows.length,
          alerts: newAlerts.length,
        });
        const [orderId, ...itemIds] = alloc.orders;
        const alertIds = alloc.alerts ?? [];
        itemRows.forEach((row, i) => {
          row.id = itemIds[i];
        });

        // ---- WRITE PHASE ----
        tx.setDoc("orderRefs", ref, { orderId });
        const order = await tx.order.create({
          data: {
            id: orderId,
            clientRef: ref,
            locationId: location.id,
            staffId: req.user.sub,
            total: orderTotal,
            status: "PAID",
            paymentMethod: payMethod,
            items: itemRows,
          },
        });
        for (const { inv, newStock } of stockWrites.values()) {
          await tx.inventoryItem.update({ where: { id: inv.id }, data: { stock: newStock } });
        }
        newAlerts.forEach((a, i) => {
          a.id = alertIds[i];
        });
        for (const a of newAlerts) {
          await tx.alert.create({ data: a });
        }
        return { dup: false, order, warnings };
      });

      if (outcome.dup) {
        const winner = await prisma.order.findUnique({
          where: { clientRef: ref },
          include: { items: true },
        });
        if (winner) {
          return res.json({ duplicate: true, order: winner, warnings: [] });
        }
        return next(new Error("Order commit did not persist"));
      }
      result = { order: outcome.order, warnings: outcome.warnings };
    } catch (err) {
      return next(err);
    }

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
      if (!Number.isFinite(start.getTime())) {
        return res.status(400).json({ error: "date must be YYYY-MM-DD" });
      }
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

// PATCH /orders/:id - void a mis-tapped sale (OWNER only). Record-only:
// the row stays in history with actor + timestamp, stock is NOT reversed.
router.patch("/orders/:id", requireAuth, requireRole("OWNER"), async (req, res, next) => {
  try {
    const { status, reason } = req.body ?? {};
    if (status !== "VOID") {
      return res.status(400).json({ error: 'only status "VOID" is supported' });
    }
    const existing = await prisma.order.findUnique({ where: { id: Number(req.params.id) } });
    if (!existing) return res.status(404).json({ error: "Order not found" });
    if (existing.status === "VOID") {
      return res.status(400).json({ error: "Order is already void" });
    }
    const updated = await prisma.order.update({
      where: { id: existing.id },
      data: {
        status: "VOID",
        voidedBy: req.user.sub,
        voidedAt: new Date(),
        voidReason: reason ? String(reason).slice(0, 500) : null,
      },
      include: { items: true },
    });
    return res.json({ order: updated });
  } catch (err) {
    return next(err);
  }
});

export default router;
