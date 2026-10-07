import { Router } from "express";
import { db as prisma } from "../firestore.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { requireDevice } from "../middleware/device.js";
import { manilaDayRange, manilaDayStart } from "../services/timezone.js";
import { lowStockDedupeKey, shouldOpenLowStockAlert } from "../services/low_stock_alert.js";
import { lookupUid, normalizeRfidUid } from "../services/rfid.js";
import { CLAIM_BOUND, resolveClaim } from "../services/rfid_claims.js";
import { bindClaimedTag } from "../services/rfid_bind.js";

const router = Router();

const CHANNELS = {
  LPG_TANK: "LPG Tank",
  CHEESE_BIN: "Cheese Powder",
};
const EVENTS = ["IN", "OUT"];

function asArray(body, key) {
  if (Array.isArray(body)) return body;
  return Array.isArray(body?.[key]) ? body[key] : null;
}

// POST /api/iot/readings  (device auth)
// Body: { cart_id?, device_id?, readings: [{channel:"LPG_TANK"|"CHEESE_BIN", kg, ts?}] }
// cart_id/device_id are informational: the location always comes from the
// authenticated device token. A mismatched cart_id is a misconfiguration.
router.post("/iot/readings", requireDevice, async (req, res, next) => {
  try {
    const rows = asArray(req.body, "readings");
    if (!rows || rows.length === 0) {
      return res.status(400).json({ error: "readings array is required" });
    }
    if (rows.length > 200) {
      return res.status(400).json({ error: "max 200 readings per request" });
    }
    const location = req.device.location;
    if (req.body?.cart_id && String(req.body.cart_id) !== location.code) {
      return res.status(400).json({
        error: `cart_id "${req.body.cart_id}" does not match device location "${location.code}"`,
      });
    }

    // Firestore transactions require ALL reads before ALL writes:
    // read phase (stock rows + unread alerts), compute phase (same
    // validation/messages as before), then write phase. Sensor stock
    // updates keep the same threshold-alert rules as POS orders.
    // accepted/rejected are built INSIDE the txn and returned: runTransaction
    // retries the whole fn on contention, so outer arrays would duplicate
    // entries on retry.
    const outcome = await prisma.runTransaction(async (tx) => {
      const accepted = [];
      const rejected = [];
      // ---- READ PHASE ----
      // No LOW_STOCK scan: this batch runs many times a day per cart and each one
      // used to read every alert ever created. Dedupe is one point read per
      // channel that crossed. See services/low_stock_alert.js.
      const invRows = await tx.inventoryItem.findMany({ where: { locationId: location.id } });
      const invByName = new Map(invRows.map((r) => [r.name, r]));

      // ---- COMPUTE PHASE ----
      // Note: readings are stored even when their inventory row is missing
      // (rejected from `accepted` but still recorded), exactly as before.
      const plans = [];
      const createdNeedles = new Set();
      const newAlerts = [];
      for (const r of rows) {
        const itemName = CHANNELS[r.channel];
        const kg = Number(r.kg);
        if (!itemName || !Number.isFinite(kg) || kg < 0 || kg > 1000) {
          rejected.push({ channel: r.channel ?? null, reason: "invalid channel or kg" });
          continue;
        }
        const ts = r.ts ? new Date(r.ts) : new Date();
        if (!Number.isFinite(ts.getTime())) {
          rejected.push({ channel: r.channel ?? null, reason: "invalid ts" });
          continue;
        }
        const inv = invByName.get(itemName) ?? null;
        if (!inv) {
          plans.push({ row: r, itemName, kg, ts, inv });
          rejected.push({ channel: r.channel, reason: `no inventory row "${itemName}"` });
        } else if (inv.updatedAt && ts.getTime() < new Date(inv.updatedAt).getTime() - 60 * 1000) {
          // Stale replay guard: a reading older than the current stock write
          // (beyond 60s clock tolerance) must not clobber a newer POS sale.
          // Still stored below, but excluded from accepted + stock mirror.
          plans.push({ row: r, itemName, kg, ts, inv: null, staleInv: inv });
          rejected.push({ channel: r.channel, reason: "stale ts older than current stock" });
        } else {
          plans.push({ row: r, itemName, kg, ts, inv });
          accepted.push({ channel: r.channel, kg, ts: ts.toISOString() });
        }
      }

      // ---- CROSSING DETECTION (pure: sequential running stock per item,
      // applyStockChange parity — alert only on threshold CROSSING) ----
      const running = new Map();
      for (const plan of plans) {
        if (!plan.inv) continue;
        const base = running.has(plan.inv.id) ? running.get(plan.inv.id) : plan.inv.stock;
        running.set(plan.inv.id, plan.kg);
        if (base > plan.inv.threshold && plan.kg <= plan.inv.threshold) {
          // One keyed lookup instead of scanning every alert in history.
          if (await shouldOpenLowStockAlert({
            locationId: location.id,
            inventoryItemId: plan.inv.id,
            known: createdNeedles,
            lookup: (key) => tx.alert.findMany({ where: { lowStockKey: key }, take: 4 }),
          })) {
            newAlerts.push({
              type: "LOW_STOCK",
              // Indexed field: the dedupe above never has to scan.
              lowStockKey: lowStockDedupeKey(location.id, plan.inv.id),
              message: `${plan.inv.name} @ ${location.code} dropped below threshold (${plan.kg} ${plan.inv.unit} left)`,
              payload: JSON.stringify({
                dedupeKey: lowStockDedupeKey(location.id, plan.inv.id),
                inventoryItemId: plan.inv.id,
                locationId: location.id,
                stock: plan.kg,
                threshold: plan.inv.threshold,
                unit: plan.inv.unit,
              }),
            });
          }
        }
      }

      // ---- ID ALLOCATION (last reads of the transaction) ----
      // NOTE: crossing detection MUST run before this (it only reads plans
      // plus prior iterations, no writes) so newAlerts is fully populated.
      const alloc = await tx.allocIds({
        sensorReadings: plans.length,
        alerts: newAlerts.length,
      });
      const readingIds = alloc.sensorReadings;
      const alertIds = alloc.alerts ?? [];

      // ---- WRITE PHASE ----
      for (let i = 0; i < plans.length; i++) {
        const plan = plans[i];
        await tx.sensorReading.create({
          data: {
            id: readingIds[i],
            locationId: location.id,
            channel: plan.row.channel,
            kg: plan.kg,
            ts: plan.ts,
            deviceId: req.device.deviceId,
          },
        });
        if (plan.inv) {
          await tx.inventoryItem.update({
            where: { id: plan.inv.id },
            data: { stock: plan.kg },
          });
        }
      }
      for (const [i, a] of newAlerts.entries()) {
        a.id = alertIds[i];
        await tx.alert.create({ data: a });
      }
      await tx.device.update({
        where: { id: req.device.id },
        data: { lastSeenAt: new Date() },
      });
      return { accepted, rejected };
    });

    return res.status(201).json({ accepted: outcome.accepted, rejected: outcome.rejected });
  } catch (err) {
    return next(err);
  }
});

// POST /api/shifts  (device auth)
// Body: { cart_id?, device_id?, events: [{staff_uid, event:"IN"|"OUT", ts?}] }
router.post("/shifts", requireDevice, async (req, res, next) => {
  try {
    const rows = asArray(req.body, "events");
    if (!rows || rows.length === 0) {
      return res.status(400).json({ error: "events array is required" });
    }
    if (rows.length > 200) {
      return res.status(400).json({ error: "max 200 events per request" });
    }
    const location = req.device.location;
    if (req.body?.cart_id && String(req.body.cart_id) !== location.code) {
      return res.status(400).json({
        error: `cart_id "${req.body.cart_id}" does not match device location "${location.code}"`,
      });
    }

    // A tap is the only moment a card is physically present, so this is where a
    // pending self-service registration is completed. Runs BEFORE the txn so
    // the user lookup below already sees the freshly bound tag - the tap then
    // records a real shift for the person who just registered.
    const registrations = [];
    for (const e of rows) {
      const uid = String(e?.staff_uid ?? "").trim();
      if (!uid) continue;
      const bound = await bindClaimedTag({ rawUid: uid, locationId: location.id });
      if (!bound) continue;
      registrations.push(bound);
      // The person pressed Time In or Time Out in the app, so the shift must
      // record THAT. The firmware only knows how to toggle, and toggling would
      // silently log someone OUT when they meant to clock IN.
      if (bound.outcome === "bound" && bound.desiredEvent) {
        e.event = bound.desiredEvent;
      }
    }

    // Same reads-first restructure as /iot/readings: users and unread
    // UNKNOWN_CARD alerts are prefetched, then shifts + alerts are written.
    // accepted/rejected live INSIDE the txn (see above) so contention
    // retries cannot duplicate response entries.
    const outcome = await prisma.runTransaction(async (tx) => {
      const accepted = [];
      const rejected = [];
      // ---- READ PHASE (users table is tiny; match UIDs in code) ----
      const [users, unreadAlerts] = await Promise.all([
        tx.user.findMany(),
        tx.alert.findMany({ where: { type: "UNKNOWN_CARD", isRead: false } }),
      ]);
      // Both sides of the comparison are normalized. A row stored before the
      // normalization fix (lowercase, or with separators a human pasted in)
      // would otherwise never match a tap and the card would silently become
      // an UNKNOWN_CARD alert forever.
      const byUid = new Map(
        users
          .filter((u) => u.rfidUid)
          .map((u) => [lookupUid(u.rfidUid), u]),
      );

      // ---- COMPUTE PHASE (same validation/messages as before) ----
      const plans = [];
      const createdNeedles = new Set();
      const newAlerts = [];
      for (const e of rows) {
        const uid = String(e.staff_uid ?? "").trim();
        const event = String(e.event ?? "").toUpperCase();
        if (!uid || uid.length > 64 || !EVENTS.includes(event)) {
          rejected.push({ staff_uid: uid || null, reason: "invalid uid or event" });
          continue;
        }
        const ts = e.ts ? new Date(e.ts) : new Date();
        if (!Number.isFinite(ts.getTime())) {
          rejected.push({ staff_uid: uid || null, reason: "invalid ts" });
          continue;
        }
        const user = byUid.get(lookupUid(uid)) ?? null;
        plans.push({ uid, event, ts, user });
        if (!user) {
          const dedupeKey = `unknown:${location.id}:${uid}`;
          const dup =
            createdNeedles.has(dedupeKey) ||
            unreadAlerts.some((a) => {
              try {
                if (JSON.parse(a.payload ?? "{}")?.dedupeKey === dedupeKey) return true;
              } catch {}
              return (a.message ?? "").includes(`Unknown RFID card ${uid}`);
            });
          if (!dup) {
            createdNeedles.add(dedupeKey);
            newAlerts.push({
              type: "UNKNOWN_CARD",
              message: `Unknown RFID card ${uid} tapped at ${location.code} - register this card`,
              payload: JSON.stringify({ dedupeKey, uid, locationId: location.id, locationCode: location.code }),
            });
          }
        }
        accepted.push({ staff_uid: uid, event, matched: user ? user.name : null });
      }

      // ---- ID ALLOCATION (last reads of the transaction) ----
      const shiftAlloc = await tx.allocIds({
        shifts: plans.length,
        alerts: newAlerts.length,
      });
      const shiftIds = shiftAlloc.shifts;
      const shiftAlertIds = shiftAlloc.alerts ?? [];

      // ---- WRITE PHASE ----
      for (let i = 0; i < plans.length; i++) {
        const plan = plans[i];
        await tx.shift.create({
          data: {
            id: shiftIds[i],
            staffUid: plan.uid,
            staffId: plan.user?.id ?? null,
            staffName: plan.user?.name ?? null,
            locationId: location.id,
            event: plan.event,
            ts: plan.ts,
            deviceId: req.device.deviceId,
          },
        });
      }
      for (const [i, a] of newAlerts.entries()) {
        a.id = shiftAlertIds[i];
        await tx.alert.create({ data: a });
      }
      await tx.device.update({
        where: { id: req.device.id },
        data: { lastSeenAt: new Date() },
      });
      return { accepted, rejected };
    });

    // The shift is committed now, so tell each claim what was ACTUALLY written.
    // The app toasts from this rather than from what was requested: a tap can
    // still be rejected (bad event, closed cart) and the person must be told
    // the truth, not what they hoped for.
    for (const reg of registrations) {
      if (reg.outcome !== "bound" || !reg.claimId) continue;
      const written = outcome.accepted.find(
        (a) => normalizeRfidUid(a.staff_uid) === reg.rfidUid && a.matched,
      );
      resolveClaim(reg.claimId, CLAIM_BOUND, reg.rfidUid, null, written?.event ?? null);
    }

    return res.status(201).json({
      accepted: outcome.accepted,
      rejected: outcome.rejected,
      // Tell the reader's owner what the tap did: registered a card, refused
      // one that belongs to someone else, or nothing was pending.
      registrations,
    });
  } catch (err) {
    return next(err);
  }
});

// POST /api/shifts/manual (OWNER, user JWT) — manager correction for a missed
// RFID tap. Device auth deliberately NOT required here: this is the dashboard
// path, while POST /shifts stays device-only. Using the device endpoint with
// a user token 401s (and must never be used as a fallback).
// Body: { staffId, locationCode, event: "IN"|"OUT", ts? }
router.post("/shifts/manual", requireAuth, requireRole("OWNER"), async (req, res, next) => {
  try {
    const { staffId, locationCode, event, ts } = req.body ?? {};
    const ev = String(event ?? "").toUpperCase();
    if (!["IN", "OUT"].includes(ev)) {
      return res.status(400).json({ error: 'event must be "IN" or "OUT"' });
    }
    if (locationCode === undefined || locationCode === "") {
      return res.status(400).json({ error: "locationCode is required" });
    }
    if (staffId === undefined || staffId === "" || staffId === null) {
      return res.status(400).json({ error: "staffId is required" });
    }
    const [user, location] = await Promise.all([
      prisma.user.findUnique({ where: { id: Number(staffId) } }),
      prisma.location.findUnique({ where: { code: String(locationCode) } }),
    ]);
    if (!user) return res.status(404).json({ error: "Staff not found" });
    if (!location) return res.status(404).json({ error: "Location not found" });
    const at = ts ? new Date(ts) : new Date();
    if (!Number.isFinite(at.getTime())) {
      return res.status(400).json({ error: "ts must be a valid date" });
    }
    const [id] = await prisma.shift.nextIds(1);
    const shift = await prisma.shift.create({
      data: {
        id,
        staffUid: user.rfidUid ?? `MANUAL-${user.id}`,
        staffId: user.id,
        staffName: user.name,
        locationId: location.id,
        event: ev,
        ts: at,
        deviceId: "MANUAL",
      },
    });
    return res.status(201).json({ shift });
  } catch (err) {
    return next(err);
  }
});

// PATCH /shifts/:id (OWNER, user JWT) — correct a shift log row
// (event/location/timestamp). Staff identity is immutable here; delete +
// re-log if the wrong person was recorded.
// Body: { event?: "IN"|"OUT", locationCode?, ts? } (at least one required)
router.patch("/shifts/:id", requireAuth, requireRole("OWNER"), async (req, res, next) => {
  try {
    const { event, locationCode, ts } = req.body ?? {};
    if (event === undefined && locationCode === undefined && ts === undefined) {
      return res.status(400).json({ error: "provide event, locationCode, or ts" });
    }
    const existing = await prisma.shift.findUnique({ where: { id: Number(req.params.id) } });
    if (!existing) return res.status(404).json({ error: "Shift not found" });
    const data = {};
    if (event !== undefined) {
      const ev = String(event).toUpperCase();
      if (!["IN", "OUT"].includes(ev)) {
        return res.status(400).json({ error: 'event must be "IN" or "OUT"' });
      }
      data.event = ev;
    }
    if (locationCode !== undefined) {
      const location = await prisma.location.findUnique({ where: { code: String(locationCode) } });
      if (!location) return res.status(404).json({ error: "Location not found" });
      data.locationId = location.id;
    }
    if (ts !== undefined) {
      const at = new Date(ts);
      if (!Number.isFinite(at.getTime())) {
        return res.status(400).json({ error: "ts must be a valid date" });
      }
      data.ts = at;
    }
    const shift = await prisma.shift.update({
      where: { id: existing.id },
      data,
      include: { location: { select: { code: true, name: true } } },
    });
    return res.json({ shift });
  } catch (err) {
    return next(err);
  }
});

// DELETE /shifts/:id (OWNER, user JWT) — remove a mis-logged shift row.
router.delete("/shifts/:id", requireAuth, requireRole("OWNER"), async (req, res, next) => {
  try {
    await prisma.shift.delete({ where: { id: Number(req.params.id) } });
    return res.json({ deleted: true });
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "Shift not found" });
    return next(err);
  }
});

// GET /api/staff/on-shift -> who is currently IN per cart (latest event today, Manila day)
router.get("/staff/on-shift", requireAuth, async (_req, res, next) => {
  try {
    const start = manilaDayStart(0);
    const shifts = await prisma.shift.findMany({
      where: { ts: { gte: start } },
      include: { location: { select: { code: true, name: true } } },
      orderBy: { ts: "asc" },
    });
    const latestByPerson = new Map();
    for (const s of shifts) {
      const key = `${s.staffUid}|${s.locationId}`;
      latestByPerson.set(key, s); // ascending order keeps the newest last
    }
    const onShift = [...latestByPerson.values()]
      .filter((s) => s.event === "IN")
      .map((s) => ({
        name: s.staffName ?? `Unregistered card ${s.staffUid}`,
        registered: Boolean(s.staffName),
        since: s.ts,
        location_code: s.location.code,
        location_name: s.location.name,
      }));
    return res.json({
      on_shift: onShift,
      recent_today: shifts.slice(-20).reverse(),
    });
  } catch (err) {
    return next(err);
  }
});

// GET /api/shifts/history?code=&date=&page=&pageSize= - paged shift log
router.get("/shifts/history", requireAuth, async (req, res, next) => {
  try {
    const { code, date } = req.query;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(Number(req.query.pageSize) || 10, 100);
    const where = {};
    if (code) where.location = { code: String(code) };
    if (date) {
      const range = manilaDayRange(String(date));
      if (!range) {
        return res.status(400).json({ error: "date must be YYYY-MM-DD" });
      }
      where.ts = { gte: range.start, lt: range.end };
    }
    const [total, shifts] = await Promise.all([
      prisma.shift.count({ where }),
      prisma.shift.findMany({
        where,
        include: { location: { select: { code: true, name: true } } },
        orderBy: { ts: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return res.json({
      data: shifts,
      meta: { total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    });
  } catch (err) {
    return next(err);
  }
});

// GET /api/readings/recent?code=CART-01&channel=LPG_TANK&limit=30
router.get("/readings/recent", requireAuth, async (req, res, next) => {
  try {
    const { code = "CART-01", channel = "LPG_TANK", limit = 40 } = req.query;
    const loc = await prisma.location.findUnique({ where: { code: String(code) } });
    if (!loc) return res.json({ readings: [] });
    const readings = await prisma.sensorReading.findMany({
      where: { locationId: loc.id, channel: String(channel) },
      orderBy: { ts: "desc" },
      take: Math.min(Number(limit) || 40, 200),
    });
    return res.json({ readings: readings.reverse() });
  } catch (err) {
    return next(err);
  }
});

export default router;
