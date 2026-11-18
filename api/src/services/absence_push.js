// Absence alert for the roster: when a scheduled staff member has not
// tapped IN 30 minutes after their scheduled start, the OWNER(s) get a
// single push + notification-center row for that day. Deduped once per
// staff per Manila day via the `absencePushes` collection
// (doc id = `absence_<YYYY-MM-DD>_<staffId>`), so device heartbeats every
// 30s never spam the owner.
import { db as prisma } from "../firestore.js";
import { pushToOwners } from "./push.js";
import {
  hmToMinutes,
  manilaDayKey,
  manilaMinutesOfDay,
  manilaWeekday,
  scheduleDocValue,
  WEEKDAY_LABEL,
} from "./staff_schedule.js";
import { manilaDayStart } from "./timezone.js";

// Heartbeats arrive every 10s per device; one memory-gated sweep per 10
// minutes is plenty (the 30-minute lateness window is coarse by design).
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
let lastSweepAt = 0;

export async function maybePushAbsenceAlerts() {
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;

  try {
    const dayKey = manilaDayKey(now);
    const weekday = manilaWeekday(now);
    const nowMin = manilaMinutesOfDay(now);

    // One bounded read of the (tiny) schedules collection.
    const snap = await prisma.collection("staffSchedules").get().catch(() => null);
    const docs = snap ? snap.docs ?? [] : [];
    if (!docs.length) return;

    const users = await prisma.user.findMany({ where: { role: "STAFF" } }).catch(() => []);
    const byId = new Map((users ?? []).filter((u) => u?.id != null).map((u) => [Number(u.id), u]));

    // Which staff already tapped IN today (any cart) — one query, not one per staff.
    let inStaffIds = new Set();
    try {
      const inShifts = await prisma.shift.findMany({
        where: { ts: { gte: manilaDayStart(0) }, event: "IN" },
      });
      inStaffIds = new Set((inShifts ?? []).map((s) => Number(s.staffId)).filter(Number.isFinite));
    } catch {
      // Unreadable shifts — bail rather than guess who is absent.
      return;
    }

    for (const doc of docs) {
      const staffId = Number(doc.id);
      if (!Number.isFinite(staffId)) continue;
      const raw = { staffId, ...(doc.data() ?? {}) };
      const sched = scheduleDocValue(raw);
      if (!sched) continue;
      const entry = sched.days[weekday];
      if (!entry) continue; // day off — nobody is absent
      const startMin = hmToMinutes(entry.start);
      if (nowMin < startMin + 30) continue; // still inside the grace window
      if (inStaffIds.has(staffId)) continue; // they tapped in
      const user = byId.get(staffId);
      if (!user || user.active === false) continue;

      // Once per staff per day.
      const markerId = `absence_${dayKey}_${staffId}`;
      const markerRef = prisma.collection("absencePushes").doc(markerId);
      const marker = await markerRef.get().catch(() => null);
      if (marker?.exists) continue;

      const name = user.name ?? user.username ?? `Staff ${staffId}`;
      await markerRef.set({ staffId, date: dayKey, at: new Date() }).catch(() => {});
      await pushToOwners({
        title: "No time in yet",
        body: `${name} is scheduled ${entry.start}-${entry.end} on ${WEEKDAY_LABEL[weekday]} but has not tapped in.`,
        data: { link: "attendance", staffId, date: dayKey, staffName: name },
      }).catch(() => {});
    }
  } catch {
    // The absence sweep is best-effort; a heartbeat must never fail.
  }
}
