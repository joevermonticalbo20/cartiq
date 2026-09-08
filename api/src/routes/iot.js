import { Router } from "express";
import { prisma } from "../prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { requireDevice } from "../middleware/device.js";
import { applyStockChange } from "../services/inventory_rules.js";

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
// Body: { readings: [{channel:"LPG_TANK"|"CHEESE_BIN", kg, ts?}] }
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
    const accepted = [];
    const rejected = [];

    await prisma.$transaction(async (tx) => {
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
        await tx.sensorReading.create({
          data: {
            locationId: location.id,
            channel: r.channel,
            kg,
            ts,
            deviceId: req.device.deviceId,
          },
        });
        const inv = await tx.inventoryItem.findFirst({
          where: { locationId: location.id, name: itemName },
        });
        if (!inv) {
          rejected.push({ channel: r.channel, reason: `no inventory row "${itemName}"` });
          continue;
        }
        await applyStockChange(tx, { inv, newStock: kg, location });
        accepted.push({ channel: r.channel, kg, ts: ts.toISOString() });
      }
      await tx.device.update({
        where: { id: req.device.id },
        data: { lastSeenAt: new Date() },
      });
    });

    return res.status(201).json({ accepted, rejected });
  } catch (err) {
    return next(err);
  }
});

// POST /api/shifts  (device auth)
// Body: { events: [{staff_uid, event:"IN"|"OUT", ts?}] }
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
    const accepted = [];
    const rejected = [];

    await prisma.$transaction(async (tx) => {
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
        const user = await prisma.user.findUnique({ where: { rfidUid: uid } });
        await tx.shift.create({
          data: {
            staffUid: uid,
            staffId: user?.id ?? null,
            staffName: user?.name ?? null,
            locationId: location.id,
            event,
            ts,
            deviceId: req.device.deviceId,
          },
        });
        if (!user) {
          const needle = `Unknown RFID card ${uid}`;
          const dup = await tx.alert.findFirst({
            where: { type: "UNKNOWN_CARD", isRead: false, message: { contains: needle } },
          });
          if (!dup) {
            await tx.alert.create({
              data: {
                type: "UNKNOWN_CARD",
                message: `${needle} tapped at ${location.code} - register this card`,
                payload: JSON.stringify({ uid, locationCode: location.code }),
              },
            });
          }
        }
        accepted.push({ staff_uid: uid, event, matched: user ? user.name : null });
      }
      await tx.device.update({
        where: { id: req.device.id },
        data: { lastSeenAt: new Date() },
      });
    });

    return res.status(201).json({ accepted, rejected });
  } catch (err) {
    return next(err);
  }
});

// GET /api/staff/on-shift -> who is currently IN per cart (latest event today)
router.get("/staff/on-shift", requireAuth, async (_req, res, next) => {
  try {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
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
      const start = new Date(`${date}T00:00:00`);
      if (!Number.isFinite(start.getTime())) {
        return res.status(400).json({ error: "date must be YYYY-MM-DD" });
      }
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      where.ts = { gte: start, lt: end };
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
