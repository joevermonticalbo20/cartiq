import { Router } from "express";
import { db as prisma } from "../firestore.js";
import { requireAuth, requireRole, assertOwnLocation } from "../middleware/auth.js";
import { flavorSharesForOrderLine, fmtStock, mapsForOrderLine, oversellShortage, planVoidRestores } from "../services/inventory_rules.js";
import { lowStockDedupeKey, shouldOpenLowStockAlert } from "../services/low_stock_alert.js";
import { notifyAssignedStaffOfLowStock } from "../services/staff_low_stock_notify.js";
import { manilaDayRange } from "../services/timezone.js";
import { IMAGE_MAX_BYTES, IMAGE_PREFIX } from "../services/product_images.js";
import { emit } from "./events.js";
import { sendTargetedPush } from "../services/push.js";

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
    if (items.length > 100) {
      return res.status(400).json({ error: "max 100 items per order" });
    }
    for (const it of items) {
      const qty = +it.qty;
      const price = +it.unitPrice;
      if (typeof it.productName !== "string" || !it.productName.trim() ||
          !Number.isInteger(qty) || qty < 1 || qty > 100 ||
          !Number.isFinite(price) || price < 0 || price > 10000) {
        return res.status(400).json({
          error: "each item needs a productName, an integer qty 1-100 and a unitPrice 0-10000",
        });
      }
      if (it.flavorShares !== undefined) {
        const shares = it.flavorShares;
        const valid = Array.isArray(shares) &&
          shares.length >= 2 && shares.length <= 3 &&
          shares.every((entry) =>
            entry && typeof entry.flavor === "string" && entry.flavor.trim() &&
            entry.flavor.length <= 80 && Number.isFinite(+entry.share) &&
            +entry.share > 0 && +entry.share <= 1
          ) &&
          new Set(shares.map((entry) => entry.flavor.trim())).size === shares.length &&
          Math.abs(shares.reduce((sum, entry) => sum + +entry.share, 0) - 1) < 0.0001;
        if (!valid) {
          return res.status(400).json({
            error: "flavorShares must contain 2-3 unique flavors with positive shares totaling 1",
          });
        }
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
    const PAYMENT_METHODS = ["CASH", "GCASH"];
    const payMethod =
      paymentMethod === undefined || paymentMethod === null || paymentMethod === ""
        ? null
        : String(paymentMethod).toUpperCase();
    if (payMethod !== null && !PAYMENT_METHODS.includes(payMethod)) {
      return res.status(400).json({ error: "paymentMethod must be one of: CASH, GCASH" });
    }
    const location = await prisma.location.findFirst({
      where: locationId !== undefined ? { id: +locationId } : { code: locationCode },
    });
    if (!location) return res.status(404).json({ error: "Location not found" });
    // STAFF may only sell at their assigned cart (OWNERs bypass).
    assertOwnLocation(req, location.id);

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
        // No `tx.alert.findMany({ type: "LOW_STOCK" })` here. It read every alert
        // ever created on every sale, and alerts are never deleted - that scan
        // alone was the biggest consumer of the 50k/day free-tier read budget.
        // Dedupe is now one point read per item that crossed. See
        // services/low_stock_alert.js.
        const [maps, invRows, catalogProducts] = await Promise.all([
          tx.ingredientMap.findMany(),
          tx.inventoryItem.findMany({ where: { locationId: location.id } }),
          tx.product.findMany({ select: { name: true } }),
        ]);
        const invByName = new Map(invRows.map((r) => [r.name, r]));
        const knownProducts = new Set(catalogProducts.map((p) => p.name));

        // ---- COMPUTE PHASE (pure; mirrors the original per-item loop) ----
        // Server is the source of truth for the total - never trust the client.
        const orderTotal = items.reduce((sum, it) => sum + +it.qty * +it.unitPrice, 0);
        const itemRows = items.map((it) => ({
          productName: String(it.productName).trim().slice(0, 120),
          flavor: it.flavor == null ? null : String(it.flavor).slice(0, 80),
          qty: Math.trunc(+it.qty),
          unitPrice: +it.unitPrice,
          ...(it.flavorShares !== undefined
            ? { flavorShares: flavorSharesForOrderLine(it).map((entry) => ({
                flavor: entry.flavor.trim().slice(0, 80),
                share: +entry.share,
              })) }
            : {}),
        }));
        const warnings = [];
        const stockWrites = new Map(); // invId -> { inv, newStock }
        const createdNeedles = new Set();
        const newAlerts = [];
        for (const row of itemRows) {
          // Unknown product (e.g. deleted after the POS loaded its catalog):
          // record the sale but warn loudly — nothing was deducted.
          if (!knownProducts.has(row.productName)) {
            warnings.push(`unknown product "${row.productName}" — recorded without deduction`);
            continue;
          }
          for (const { flavor, share } of flavorSharesForOrderLine(row)) {
            for (const map of mapsForOrderLine(maps, row.productName, flavor ?? "")) {
              const inv = invByName.get(map.itemName);
              if (!inv) {
                warnings.push(`no inventory row "${map.itemName}" at ${location.code}`);
                continue;
              }
              const base = stockWrites.has(inv.id) ? stockWrites.get(inv.id).newStock : inv.stock;
              const amountPerUnit = map.amountPerUnit * share;
              const deduction = amountPerUnit * row.qty;
              const newStock = Math.max(0, base - deduction);
              const shortage = oversellShortage(base, amountPerUnit, row.qty);
              if (shortage > 0) {
                warnings.push(
                  `OVERSOLD "${map.itemName}" at ${location.code}: requested ${fmtStock(deduction)} ${inv.unit}, had ${fmtStock(base)}, short ${fmtStock(shortage)}`
                );
              }
              const crossed = base > inv.threshold && newStock <= inv.threshold;
              stockWrites.set(inv.id, { inv, newStock });
              if (crossed) {
                if (await shouldOpenLowStockAlert({
                  locationId: location.id,
                  inventoryItemId: inv.id,
                  known: createdNeedles,
                  lookup: (key) => tx.alert.findMany({ where: { lowStockKey: key }, take: 4 }),
                })) {
                  newAlerts.push({
                    type: "LOW_STOCK",
                    lowStockKey: lowStockDedupeKey(location.id, inv.id),
                    message: `${inv.name} @ ${location.code} dropped below threshold (${newStock} ${inv.unit} left)`,
                    payload: JSON.stringify({
                      dedupeKey: lowStockDedupeKey(location.id, inv.id),
                      inventoryItemId: inv.id,
                      locationId: location.id,
                      stock: newStock,
                      threshold: inv.threshold,
                      unit: inv.unit,
                    }),
                  });
                }
              }
            }
          }
        }

        // ---- ID ALLOCATION (last reads of the transaction) ----
        // Alerts stay counter-allocated: the `alerts` model is numeric and
        // fromDoc coerces the doc name with Number(), so a string id would
        // surface as NaN and break ack/read by id. The read saving comes from
        // the dedupe lookup, not from the id.
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
        return { dup: false, order, warnings, newAlerts };
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
      result = { order: outcome.order, warnings: outcome.warnings, newAlerts: outcome.newAlerts ?? [] };
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

    // Owner notification: a persisted SALE alert feeds the bell on reload
    // (/alerts) and the live stream (alert:new) for open dashboards. A
    // notification must never fail a recorded sale, hence the try/catch.
    try {
      const staffName = req.user?.name ?? req.user?.username;
      const message =
        `New sale: ₱${Number(result.order.total).toFixed(2)} · ` +
        `${result.order.items.length} item(s) at ${location.code}` +
        (staffName ? ` · ${staffName}` : "");
      const alert = await prisma.alert.create({
        data: {
          type: "SALE",
          title: "New sale",
          locationId: location.id,
          message,
          payload: JSON.stringify({
            orderId: result.order.id,
            total: result.order.total,
            itemCount: result.order.items.length,
            locationCode: location.code,
          }),
        },
      });
      emit("alert:new", {
        id: alert.id,
        type: alert.type,
        userId: alert.userId ?? null,
        title: alert.title ?? null,
        message: alert.message,
        isRead: alert.isRead === true,
        createdAt: alert.createdAt,
        locationId: alert.locationId ?? null,
      });
    } catch {
      // best-effort only
    }

    for (const low of result.newAlerts ?? []) {
      try {
        const payload = JSON.parse(low.payload ?? "{}");
        await notifyAssignedStaffOfLowStock({
          locationId: payload.locationId ?? location.id,
          locationCode: location.code,
          inventoryItemId: payload.inventoryItemId,
          itemName: String(low.message ?? "").split(" @ ")[0] || "Item",
          stock: payload.stock,
          threshold: payload.threshold,
          unit: payload.unit ?? "",
        });
      } catch {
        // Targeted push must never fail the sale.
      }
    }

    return res.status(201).json({ duplicate: false, ...result, locationCode: location.code });
  } catch (err) {
    return next(err);
  }
});

// GET /api/orders/pending-void-requests (OWNER) — the live action queue.
// `pending` is `order.voidRequest.status`, NOT the alert's read state.
// A notification click marks the VOID_REQUEST alert read; that must never
// remove an order that is still awaiting an owner decision.
router.get(
  "/orders/pending-void-requests",
  requireAuth,
  requireRole("OWNER"),
  async (_req, res, next) => {
    try {
      const paidOrders = await prisma.order.findMany({
        where: { status: "PAID" },
        include: {
          items: true,
          location: { select: { code: true, name: true } },
          staff: { select: { name: true } },
        },
        orderBy: { createdAt: "asc" },
        take: 5000,
      });
      const data = paidOrders.filter(
        (order) => order.voidRequest?.status === "pending"
      );
      return res.json({ data, meta: { total: data.length } });
    } catch (err) {
      return next(err);
    }
  },
);

// GET /orders
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
      const range = manilaDayRange(String(date));
      if (!range) {
        return res.status(400).json({ error: "date must be YYYY-MM-DD" });
      }
      where.createdAt = { gte: range.start, lt: range.end };
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

// PATCH /orders/:id (OWNER only) — two operations, never mixed:
//   { status: "VOID", reason? } — void a mis-tapped sale. The row stays in
//   history with actor + timestamp, and deducted recipe stock is restored
//   (auto-restore) with an audit trail. Missing inventory rows are reported in
//   warnings[] instead of failing the void.
//   { paymentMethod } — correct a mis-tapped payment method on a PAID order
//   (CASH|GCASH). Stock untouched.
const ORDER_PAYMENT_METHODS = ["CASH", "GCASH"];
router.patch("/orders/:id", requireAuth, requireRole("OWNER"), async (req, res, next) => {
  try {
    const { status, reason, paymentMethod } = req.body ?? {};
    if (status !== undefined && status !== "VOID") {
      return res.status(400).json({ error: 'only status "VOID" is supported (omit status to edit payment method)' });
    }
    const existing = await prisma.order.findUnique({
      where: { id: Number(req.params.id) },
      include: { items: true },
    });
    if (!existing) return res.status(404).json({ error: "Order not found" });
    if (status === undefined) {
      if (paymentMethod === undefined) {
        return res.status(400).json({ error: "provide paymentMethod or status VOID" });
      }
      if (existing.status === "VOID") {
        return res.status(400).json({ error: "VOID orders cannot be edited" });
      }
      const payMethod = String(paymentMethod).toUpperCase();
      if (!ORDER_PAYMENT_METHODS.includes(payMethod)) {
        return res.status(400).json({ error: "paymentMethod must be one of: CASH, GCASH" });
      }
      const updated = await prisma.order.update({
        where: { id: existing.id },
        data: { paymentMethod: payMethod },
        include: { items: true },
      });
      return res.json({ order: updated });
    }
    if (existing.status === "VOID") {
      return res.status(400).json({ error: "Order is already void" });
    }
    return res.json(await performVoid({ existing, actorId: req.user.sub, reason }));
  } catch (err) {
    return next(err);
  }
});

// Shared void executor (stock restore + audit trail). Used by the direct
// OWNER void above and by approving a staff void request. The caller has
// already verified the order exists and is PAID.
async function performVoid({ existing, actorId, reason }) {
  const trimmedReason = reason ? String(reason).slice(0, 500) : null;
  if (process.env.VOID_RESTORE === "false") {
    const updated = await prisma.order.update({
      where: { id: existing.id },
      data: { status: "VOID", voidedBy: actorId, voidedAt: new Date(), voidReason: trimmedReason },
      include: { items: true },
    });
    return { order: updated, restored: [], warnings: [] };
  }
  const outcome = await prisma.$transaction(async (tx) => {
    // Re-read order status INSIDE the txn: two parallel VOIDs both pass the
    // outside check, so the loser must abort here instead of restoring stock
    // a second time (tx.order.update is a blind write).
    const fresh = await tx.order.findUnique({ where: { id: existing.id } });
    if (!fresh) throw Object.assign(new Error("Order not found"), { status: 404 });
    if (fresh.status === "VOID") {
      throw Object.assign(new Error("Order is already void"), { status: 409 });
    }
    const [maps, invRows] = await Promise.all([
      tx.ingredientMap.findMany(),
      tx.inventoryItem.findMany({ where: { locationId: existing.locationId } }),
    ]);
    // Restore arithmetic + the orphan warning live in one shared helper
    // (services/inventory_rules.js) so the POS, the Edge Function and the
    // forecast can never disagree about which recipe a line consumed.
    const { restores, warnings } = planVoidRestores(existing.items ?? [], maps, invRows);
    const alloc = await tx.allocIds({ stockAdjustments: restores.size });
    const adjIds = alloc.stockAdjustments ?? [];
    let i = 0;
    for (const { inv, newStock, added } of restores.values()) {
      await tx.inventoryItem.update({ where: { id: inv.id }, data: { stock: newStock } });
      await tx.stockAdjustment.create({
        data: {
          id: adjIds[i++],
          inventoryItemId: inv.id,
          locationId: inv.locationId,
          actorId,
          before: inv.stock,
          after: newStock,
          reason: `VOID order #${existing.id}: restored ${added} ${inv.unit}${reason ? ` — ${String(reason).slice(0, 200)}` : ""}`.slice(0, 500),
        },
      });
    }
    const updated = await tx.order.update({
      where: { id: existing.id },
      data: { status: "VOID", voidedBy: actorId, voidedAt: new Date(), voidReason: trimmedReason },
    });
    return {
      updated,
      warnings,
      restored: [...restores.values()].map(({ inv, newStock, added }) => ({ item: inv.name, restored: added, stock: newStock })),
    };
  });
  const order = await prisma.order.findUnique({
    where: { id: existing.id },
    include: { items: true },
  });
  return { order, restored: outcome.restored, warnings: outcome.warnings };
}

// ---------- order receipts (GCash proof photos) ----------
// Same base64-in-Firestore approach as product images, but PRIVATE: receipts
// carry customer names/ref numbers, so the GET requires auth (the dashboard
// fetches it as a blob) and is limited to owners + the order's own cart.
const receiptDoc = (id) => prisma.collection("orderReceipts").doc(String(id));

function mayAccessOrder(user, order) {
  if (!user) return false;
  if (user.role === "OWNER") return true;
  return order.locationId != null && Number(user.locationId) === Number(order.locationId);
}

// POST /orders/:id/receipt (OWNER or the order's cart staff)
router.post("/orders/:id/receipt", requireAuth, async (req, res, next) => {
  try {
    const existing = await prisma.order.findUnique({ where: { id: Number(req.params.id) } });
    if (!existing) return res.status(404).json({ error: "Order not found" });
    if (!mayAccessOrder(req.user, existing)) {
      return res.status(403).json({ error: "Forbidden: outside your cart" });
    }
    const { data, mime } = req.body ?? {};
    const m = String(mime ?? "").trim().toLowerCase();
    const prefix = IMAGE_PREFIX[m];
    if (!prefix || typeof data !== "string" || !data.startsWith(prefix)) {
      return res.status(400).json({ error: "receipt must be a base64 JPEG, PNG, or WebP" });
    }
    const bytes = Buffer.from(data, "base64");
    if (bytes.length === 0) return res.status(400).json({ error: "receipt data is empty" });
    if (bytes.length > IMAGE_MAX_BYTES) {
      return res.status(413).json({ error: `receipt too large (max ${Math.round(IMAGE_MAX_BYTES / 1024)} KB)` });
    }
    const updatedAtMs = Date.now();
    await receiptDoc(existing.id).set({ mime: m, data, bytes: bytes.length, updatedAtMs });
    const receipt = { mime: m, bytes: bytes.length, updatedAtMs, uploadedBy: req.user.sub ?? null };
    const order = await prisma.order.update({
      where: { id: existing.id },
      data: { receipt },
      include: { items: true },
    });
    return res.json({ order, receipt });
  } catch (err) {
    return next(err);
  }
});

// GET /orders/:id/receipt — the bytes, authenticated (blob fetch on web).
router.get("/orders/:id/receipt", requireAuth, async (req, res, next) => {
  try {
    const existing = await prisma.order.findUnique({ where: { id: Number(req.params.id) } });
    if (!existing) return res.status(404).json({ error: "Order not found" });
    if (!mayAccessOrder(req.user, existing)) {
      return res.status(403).json({ error: "Forbidden: outside your cart" });
    }
    const snap = await receiptDoc(existing.id).get();
    if (!snap.exists) return res.status(404).json({ error: "No receipt for this order" });
    const { mime, data } = snap.data() ?? {};
    res.setHeader("Content-Type", mime || "image/jpeg");
    res.setHeader("Cache-Control", "private, max-age=3600");
    return res.send(Buffer.from(String(data ?? ""), "base64"));
  } catch (err) {
    return next(err);
  }
});

// POST /orders/:id/void-request — staff ask the owner to void a sale. The
// order stays PAID until an OWNER approves; the request rides on the order
// plus a VOID_REQUEST alert (bell/dashboard) owned by the decision.
router.post("/orders/:id/void-request", requireAuth, async (req, res, next) => {
  try {
    const existing = await prisma.order.findUnique({ where: { id: Number(req.params.id) } });
    if (!existing) return res.status(404).json({ error: "Order not found" });
    if (!mayAccessOrder(req.user, existing)) {
      return res.status(403).json({ error: "Forbidden: outside your cart" });
    }
    if (existing.status !== "PAID") {
      return res.status(400).json({ error: "Only PAID orders can be void-requested" });
    }
    if (existing.voidRequest?.status === "pending") {
      return res.status(409).json({ error: "A void request is already waiting for the owner" });
    }
    const reason = String(req.body?.reason ?? "").trim().slice(0, 500);
    const requestedByName = req.user.name ?? req.user.username ?? null;
    const alert = await prisma.alert.create({
      data: {
        type: "VOID_REQUEST",
        title: "Void request",
        locationId: existing.locationId ?? null,
        message:
          `Void request: ₱${Number(existing.total).toFixed(2)} · order #${existing.id}` +
          (requestedByName ? ` by ${requestedByName}` : "") +
          (reason ? ` · ${reason}` : ""),
        payload: JSON.stringify({ orderId: existing.id, total: existing.total, reason }),
      },
    });
    const voidRequest = {
      status: "pending",
      reason: reason || null,
      requestedBy: req.user.sub ?? null,
      requestedByName,
      requestedAt: new Date().toISOString(),
      alertId: alert.id,
    };
    const order = await prisma.order.update({
      where: { id: existing.id },
      data: { voidRequest },
      include: { items: true },
    });
    emit("alert:new", {
      id: alert.id,
      type: alert.type,
      title: alert.title ?? null,
      message: alert.message,
      isRead: alert.isRead === true,
      createdAt: alert.createdAt,
      locationId: alert.locationId ?? null,
    });
    return res.status(201).json({ order, alert });
  } catch (err) {
    return next(err);
  }
});

// PATCH /orders/:id/void-request (OWNER) — the final decision.
//   { decision: "approve" } -> performs the void (stock restored) and marks
//   the request approved; { decision: "deny" } leaves the sale PAID.
// Either way the VOID_REQUEST alert is resolved so it leaves the bell.
router.patch("/orders/:id/void-request", requireAuth, requireRole("OWNER"), async (req, res, next) => {
  try {
    const decision = String(req.body?.decision ?? "").trim().toLowerCase();
    if (!["approve", "deny"].includes(decision)) {
      return res.status(400).json({ error: 'decision must be "approve" or "deny"' });
    }
    const existing = await prisma.order.findUnique({ where: { id: Number(req.params.id) } });
    if (!existing) return res.status(404).json({ error: "Order not found" });
    if (existing.status !== "PAID") {
      return res.status(409).json({ error: "Order is not awaiting a void decision" });
    }
    const alertId = existing.voidRequest?.alertId;
    const resolveAlert = async () => {
      if (alertId == null) return;
      try {
        await prisma.alert.update({ where: { id: Number(alertId) }, data: { isRead: true } });
      } catch {
        /* alert already gone is fine */
      }
    };

    if (decision === "deny") {
      const voidRequest = { ...(existing.voidRequest ?? {}), status: "denied", decidedBy: req.user.sub ?? null, decidedAt: new Date().toISOString() };
      const order = await prisma.order.update({
        where: { id: existing.id },
        data: { voidRequest },
        include: { items: true },
      });
      await resolveAlert();
      const requesterId = existing.voidRequest?.requestedBy ? Number(existing.voidRequest.requestedBy) : null;
      if (requesterId && requesterId !== Number(req.user.sub)) {
        const notify = await prisma.alert.create({
          data: {
            type: "VOID_DECISION",
            title: "Void declined",
            message: `Order #${existing.id} stays as paid - the owner declined your void request.`,
            userId: requesterId,
            locationId: existing.locationId ?? null,
            payload: JSON.stringify({ orderId: existing.id }),
            isRead: false,
          },
        });
        emit("alert:new", { id: notify.id, type: notify.type, userId: notify.userId ?? null, title: notify.title ?? null, message: notify.message, isRead: notify.isRead === true, createdAt: notify.createdAt, locationId: notify.locationId ?? null });
        sendTargetedPush(notify).catch(() => {});
      }
      return res.json({ order, restored: [], warnings: [] });
    }

    const reasonText = existing.voidRequest?.reason
      ? `Void request: ${existing.voidRequest.reason}`
      : "Void request approved";
    const out = await performVoid({ existing, actorId: req.user.sub, reason: reasonText });
    const voidRequest = { ...(existing.voidRequest ?? {}), status: "approved", decidedBy: req.user.sub ?? null, decidedAt: new Date().toISOString() };
    const order = await prisma.order.update({
      where: { id: existing.id },
      data: { voidRequest },
      include: { items: true },
    });
    await resolveAlert();
    const requesterId = existing.voidRequest?.requestedBy ? Number(existing.voidRequest.requestedBy) : null;
    if (requesterId && requesterId !== Number(req.user.sub)) {
      const notify = await prisma.alert.create({
        data: {
          type: "VOID_DECISION",
          title: "Void approved",
          message: `Order #${existing.id} was voided at your request. Stock restored.`,
          userId: requesterId,
          locationId: existing.locationId ?? null,
          payload: JSON.stringify({ orderId: existing.id }),
          isRead: false,
        },
      });
      emit("alert:new", { id: notify.id, type: notify.type, userId: notify.userId ?? null, title: notify.title ?? null, message: notify.message, isRead: notify.isRead === true, createdAt: notify.createdAt, locationId: notify.locationId ?? null });
      sendTargetedPush(notify).catch(() => {});
    }
    emit("order:updated", { id: existing.id, status: "VOID" });
    return res.json({ order, restored: out.restored, warnings: out.warnings });
  } catch (err) {
    return next(err);
  }
});

export default router;
