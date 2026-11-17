// Firestore access for the staff schedule docs. Kept apart from
// services/staff_schedule.js so the policy stays pure and unit-testable.
import { db as prisma } from "../firestore.js";
import { normalizeDays, SCHEDULE_HISTORY_MAX } from "./staff_schedule.js";

export function isoOrNull(v) {
  if (!v) return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : null;
  if (typeof v?.toDate === "function") {
    const d = v.toDate();
    return d instanceof Date && Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** Serialize a raw schedule doc for API responses (or null). */
export function scheduleView(raw) {
  if (!raw) return null;
  const days = normalizeDays(raw.days);
  if (!days) return null;
  return {
    days,
    updatedAt: isoOrNull(raw.updatedAt),
    updatedBy: raw.updatedBy ?? null,
    updatedByName: raw.updatedByName ?? null,
    history: Array.isArray(raw.history)
      ? raw.history.slice(-SCHEDULE_HISTORY_MAX).map((h) => ({
        at: isoOrNull(h?.at),
        by: h?.by ?? null,
        byName: h?.byName ?? null,
        before: h?.before ?? null,
        after: h?.after ?? null,
      }))
      : [],
  };
}

/** All schedule docs keyed by numeric staffId. Best-effort: any read
 * failure yields an empty map, never a 500. */
export async function loadScheduleMap() {
  const map = new Map();
  try {
    const snap = await prisma.collection("staffSchedules").get();
    for (const doc of snap.docs ?? []) {
      const staffId = Number(doc.id);
      if (!Number.isFinite(staffId)) continue;
      map.set(staffId, { staffId, ...(doc.data() ?? {}) });
    }
  } catch {
    // no schedules yet (or a transient read failure) — treat everyone as unscheduled
  }
  return map;
}
