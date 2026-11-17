// Staff weekly schedules — the owner-managed roster and the staff's own
// view of it. One Firestore doc per staff member in the `staffSchedules`
// collection (doc id = String(staffId)); see services/staff_schedule.js for
// the shape and the pure policy functions.
import { Router } from "express";
import { db as prisma } from "../firestore.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { emit } from "./events.js";
import {
  normalizeDays,
  scheduleVerdict,
  SCHEDULE_HISTORY_MAX,
} from "../services/staff_schedule.js";
import {
  loadScheduleMap,
  scheduleView,
} from "../services/staff_schedule_store.js";

const router = Router();

// GET /api/staff/schedules — OWNER roster: every account + its schedule.
router.get("/staff/schedules", requireAuth, requireRole("OWNER"), async (_req, res, next) => {
  try {
    const [users, locations, scheduleMap] = await Promise.all([
      prisma.user.findMany(),
      prisma.location.findMany(),
      loadScheduleMap(),
    ]);
    const locById = new Map(locations.map((l) => [l.id, l]));
    const data = users
      .filter((u) => u.role === "STAFF")
      .map((u) => ({
        id: u.id,
        name: u.name,
        username: u.username,
        role: u.role,
        active: u.active !== false,
        locationId: u.locationId ?? null,
        locationCode: u.locationId != null ? locById.get(u.locationId)?.code ?? null : null,
        schedule: scheduleView(scheduleMap.get(u.id) ?? null),
      }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return res.json({ data });
  } catch (err) {
    return next(err);
  }
});

// PUT /api/staff/:id/schedule — OWNER upsert the weekly roster.
// Body: { days: [null | { start: "HH:MM", end: "HH:MM" } x7] }  (index 0 = Sunday)
router.put("/staff/:id/schedule", requireAuth, requireRole("OWNER"), async (req, res, next) => {
  try {
    const staffId = Number(req.params.id);
    if (!Number.isInteger(staffId) || staffId <= 0) {
      return res.status(404).json({ error: "Staff not found" });
    }
    const target = await prisma.user.findUnique({ where: { id: staffId } });
    if (!target) return res.status(404).json({ error: "Staff not found" });
    if (target.role !== "STAFF") {
      return res.status(400).json({ error: "Schedules apply to staff accounts only." });
    }
    const days = normalizeDays(req.body?.days);
    if (!days) {
      return res.status(400).json({
        error: 'Each day must be null (day off) or { "start": "HH:MM", "end": "HH:MM" } with start before end (24h).',
      });
    }

    const ref = prisma.collection("staffSchedules").doc(String(staffId));
    const existingSnap = await ref.get().catch(() => null);
    const existing = existingSnap?.exists ? existingSnap.data() ?? {} : null;
    const before = existing ? normalizeDays(existing.days) : null;
    const history = Array.isArray(existing?.history) ? existing.history.slice(-SCHEDULE_HISTORY_MAX) : [];

    const editor = req.user ?? {};
    const editorId = Number(editor.sub) || null;
    const editorName = editor.name ?? editor.username ?? "Owner";
    const entry = {
      at: new Date().toISOString(),
      by: editorId,
      byName: editorName,
      before,
      after: days,
    };
    history.push(entry);
    while (history.length > SCHEDULE_HISTORY_MAX) history.shift();

    const doc = {
      staffId,
      days,
      updatedAt: new Date(),
      updatedBy: editorId,
      updatedByName: editorName,
      history,
    };
    await ref.set(doc, { merge: false });
    // The web refetches the roster on this exact frame (parity with the
    // Edge function's broadcastEvent("staff:updated", ...)).
    try {
      emit("staff:updated", { kind: "schedule", id: staffId });
    } catch {
      /* the stream must never fail the save */
    }
    return res.json({ schedule: scheduleView(doc) });
  } catch (err) {
    return next(err);
  }
});

// GET /api/staff/my-schedule — the signed-in staff member's own week.
// Any signed-in role may read it (the POS greys its buttons from this);
// OWNER gets their own (normally absent) doc back.
router.get("/staff/my-schedule", requireAuth, async (req, res, next) => {
  try {
    const staffId = Number(req.user?.sub);
    if (!Number.isInteger(staffId) || staffId <= 0) {
      return res.status(401).json({ error: "Session account is missing" });
    }
    const snap = await prisma.collection("staffSchedules").doc(String(staffId)).get().catch(() => null);
    const raw = snap?.exists ? snap.data() : null;
    const schedule = scheduleView(raw ? { staffId, ...raw } : null);
    const now = Date.now();
    return res.json({
      schedule,
      verdictIn: scheduleVerdict(raw ? { staffId, ...raw } : null, now, "IN"),
      verdictOut: scheduleVerdict(raw ? { staffId, ...raw } : null, now, "OUT"),
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
