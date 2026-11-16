// Event days for analytics: holidays, school events, payday, raffles —
// one-off demand spikes that would otherwise poison the weekly-seasonality
// model ("every Thursday peaked +200%"). The forecast engine skips marked
// days when training the seasonal model, so the projection is the normal
// demand pattern rather than a holiday-affected blaze.
import { Router } from "express";
import { db as prisma } from "../firestore.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { announceChange } from "../services/announce.js";

const router = Router();

const LABEL_RE = /^[\p{L}\p{N}\p{M} .,'&()\-]+$/u;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateLabel(raw) {
  const value = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!value) return { ok: false, error: "Description is required" };
  if (value.length < 3) return { ok: false, error: "Description must be at least 3 characters" };
  if (value.length > 60) return { ok: false, error: "Description must not exceed 60 characters" };
  if (!LABEL_RE.test(value)) return { ok: false, error: "Description may only contain letters, digits, spaces and ., ' - & ( )" };
  return { ok: true, value };
}

function validateDate(raw) {
  const value = String(raw ?? "").trim();
  if (!DATE_RE.test(value)) return { ok: false, error: "date must be YYYY-MM-DD" };
  const d = new Date(value + "T00:00:00+08:00");
  if (!Number.isFinite(d.getTime())) return { ok: false, error: "date must be a valid calendar day" };
  return { ok: true, value };
}

async function loadEvents() {
  // One bounded read: never more events than a year's worth. The list is
  // tiny (markers deduped by date+label), so a full read is cheaper than
  // maintaining an index for a rarely-hit analytics endpoint.
  const docs = await prisma.collection("eventDays").get();
  const out = [];
  for (const doc of docs.docs ?? []) {
    const d = doc.data();
    out.push({
      id: Number(doc.id),
      date: d.date,
      label: d.label,
      locationCode: d.locationCode ?? null,
      createdAt: d.createdAt?.toDate?.()?.toISOString?.() ?? null,
    });
  }
  out.sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  return out;
}

// GET /analytics/events - list marked days (any signed-in user can read;
// the panel may want this open even to read-only logins).
router.get("/analytics/events", requireAuth, async (req, res, next) => {
  try {
    const events = await loadEvents();
    return res.json({ data: events });
  } catch (err) {
    return next(err);
  }
});

// POST /analytics/events - OWNER, body { date, label, locationCode? }
router.post("/analytics/events", requireAuth, requireRole("OWNER"), async (req, res, next) => {
  try {
    const dateCheck = validateDate(req.body?.date);
    if (!dateCheck.ok) return res.status(400).json({ error: dateCheck.error });
    const labelCheck = validateLabel(req.body?.label);
    if (!labelCheck.ok) return res.status(400).json({ error: labelCheck.error });
    const locationCode =
      req.body?.locationCode === undefined || req.body?.locationCode === null || String(req.body.locationCode).trim() === ""
        ? null
        : String(req.body.locationCode).trim().toUpperCase();
    if (locationCode !== null && !/^[A-Z0-9-]{3,40}$/.test(locationCode)) {
      return res.status(400).json({ error: "locationCode must look like CART-01" });
    }

    const clash = await prisma.collection("eventDays")
      .where("date", "==", dateCheck.value)
      .where("label", "==", labelCheck.value)
      .where("locationCode", "==", locationCode)
      .limit(1)
      .get();
    if (!clash.empty) {
      return res.status(409).json({ error: "That day and label are already marked" });
    }

    // Allocate an id atomically (inside a no-op transaction so the counter
    // never ships a half-created doc).
    const alloc = await prisma.$transaction(async (tx) => tx.allocIds({ eventDays: 1 }));
    const id = alloc.eventDays[0];

    await prisma.collection("eventDays").doc(String(id)).set({
      date: dateCheck.value,
      label: labelCheck.value,
      locationCode,
      createdBy: req.user.sub ?? req.user.id ?? null,
      createdAt: new Date(),
    });

    const doc = await prisma.collection("eventDays").doc(String(id)).get();
    await announceChange("alerts", { kind: "analytics", id }).catch(() => {});
    return res.status(201).json({ event: { id, date: doc.data().date, label: doc.data().label, locationCode: doc.data().locationCode ?? null } });
  } catch (err) {
    return next(err);
  }
});

// DELETE /analytics/events/:id - OWNER
router.delete("/analytics/events/:id", requireAuth, requireRole("OWNER"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: "Event not found" });
    const docRef = prisma.collection("eventDays").doc(String(id));
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: "Event not found" });
    await docRef.delete();
    await announceChange("alerts", { kind: "analytics", id }).catch(() => {});
    return res.json({ deleted: { id } });
  } catch (err) {
    return next(err);
  }
});

export default router;
