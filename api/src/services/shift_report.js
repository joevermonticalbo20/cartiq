// Aggregation for the Shift History report — the "how did attendance go"
// panel next to the raw forensic log. Read-time computation (no schema
// change); same rules as the per-tap punctuality badges.
//
// Both API copies mirror this file's behavior (the Edge function inlines
// its own copy) — keep them in step.
import { manilaDayKey, manilaDowOfKey } from "./timezone.js";
import {
  hmToMinutes,
  manilaMinutesOfDay,
  scheduleDocValue,
  entryForInstant,
} from "./staff_schedule.js";

/** Inclusive list of Manila day keys from `days` ago through today. */
export function reportDayKeys(days) {
  const d = Math.max(1, Math.min(90, Math.floor(Number(days) || 28)));
  const now = Date.now();
  const keys = [];
  for (let i = d - 1; i >= 0; i--) {
    keys.push(manilaDayKey(new Date(now - i * 24 * 60 * 60 * 1000)));
  }
  return { days: d, keys };
}

/**
 * Aggregate a window of shift rows into a per-staff report.
 *   shifts     — rows with { staffId, staffName?, event, ts } (any location)
 *   staffUsers — the STAFF accounts (rows for unknown staff are ignored)
 *   scheduleMap — staffSchedules map (id → raw doc) for roster/classification
 *   days       — the window
 * Returns { period_days, generated_at, totals, staff[] } — deterministic.
 */
export function aggregateShiftReport({ shifts, staffUsers, scheduleMap, days, now }) {
  const { days: periodDays, keys } = reportDayKeys(days);
  const effectiveNow = Number(now) || Date.now();
  const keySet = new Set(keys);

  // Scheduled day count per staff from the current roster (documented in the
  // UI as "vs current roster").
  const buckets = new Map();
  for (const u of staffUsers ?? []) {
    const id = Number(u.id);
    if (!Number.isFinite(id)) continue;
    const raw = scheduleMap?.get?.(id) ?? null;
    const sched = raw ? scheduleDocValue(raw) : null;
    const scheduledDays = sched
      ? keys.filter((k) => sched.days[manilaDowOfKey(k)]).length
      : 0;
    buckets.set(id, {
      staff_id: id,
      name: u.name ?? `Staff ${id}`,
      username: u.username ?? "",
      role: u.role ?? "STAFF",
      active: u.active !== false,
      locationCode: u.location?.code ?? u.locationCode ?? null,
      scheduled_days: scheduledDays,
      clock_ins: 0,
      clock_outs: 0,
      on_time: 0,
      tardy: 0,
      early_out: 0,
      overtime_min: 0,
      overtime_hours: 0,
      absences: 0,
      hours_worked: 0,
      in_days: new Set(),
      out_min: new Map(), // dayKey -> latest OUT minutes-of-day
      in_min: new Map(), // dayKey -> earliest IN minutes-of-day
      day_events: new Map(), // dayKey -> [{event, minutes}]
    });
  }

  // Tardy needs minutes; derive from the tap itself.
  for (const s of shifts ?? []) {
    const staffId = Number(s?.staffId ?? s?.staff?.id);
    const b = buckets.get(staffId);
    if (!b) continue; // staff row gone (deleted account) — skip from the report
    const ts = new Date(s.ts);
    if (!Number.isFinite(ts.getTime())) continue;
    const dayKey = manilaDayKey(ts);
    if (!keySet.has(dayKey)) continue;
    const minute = manilaMinutesOfDay(ts.getTime());
    const event = String(s.event ?? "").toUpperCase();
    const raw = scheduleMap?.get?.(staffId) ?? null;
    const entry = raw ? entryForInstant(raw, ts) : undefined;

    const dayEvents = b.day_events.get(dayKey) ?? [];
    dayEvents.push({ event, minute, entry });
    b.day_events.set(dayKey, dayEvents);

    if (event === "IN") {
      b.clock_ins += 1;
      b.in_days.add(dayKey);
      if (!b.in_min.has(dayKey) || minute < b.in_min.get(dayKey)) b.in_min.set(dayKey, minute);
      if (entry) {
        const start = hmToMinutes(entry.start);
        if (minute - start > 5) {
          b.tardy += 1;
        } else {
          b.on_time += 1;
        }
      }
    } else if (event === "OUT") {
      b.clock_outs += 1;
      if (!b.out_min.has(dayKey) || minute > b.out_min.get(dayKey)) b.out_min.set(dayKey, minute);
      if (entry) {
        const end = hmToMinutes(entry.end);
        if (end - minute > 5) {
          b.early_out += 1;
        } else if (minute - end > 0) {
          b.overtime_min += minute - end;
        }
      }
    }
  }

  // Worked hours: IN→OUT pair per staff per day.
  for (const b of buckets.values()) {
    let hours = 0;
    for (const dayKey of keys) {
      const inMin = b.in_min.get(dayKey);
      const outMin = b.out_min.get(dayKey);
      if (inMin == null || outMin == null) continue;
      let diff = outMin - inMin;
      if (diff < 0 || diff > 16 * 60) continue; // corrupt pair — ignore, not counted
      hours += diff / 60;
    }
    b.hours_worked = Number(hours.toFixed(1));
    b.overtime_hours = Number((b.overtime_min / 60).toFixed(1));
  }

  // Absences: a scheduled day with no IN tap.
  for (const [id, b] of buckets) {
    const raw = scheduleMap?.get?.(id) ?? null;
    const sched = raw ? scheduleDocValue(raw) : null;
    b.absences = 0;
    if (sched) {
      for (const key of keys) {
        if (sched.days[manilaDowOfKey(key)] && !b.in_days.has(key)) b.absences += 1;
      }
    }
  }

  const roundPct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : null);
  const staff = [...buckets.values()]
    .map((b) => {
      const { in_days, out_min, in_min, day_events, events, ...pub } = b;
      const on_time_pct = roundPct(b.on_time, b.on_time + b.tardy);
      return {
        ...pub,
        on_time_pct,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const totals = {
    clock_ins: 0, clock_outs: 0, on_time: 0, tardy: 0, early_out: 0,
    overtime_min: 0, overtime_hours: 0, absences: 0, hours_worked: 0,
  };
  for (const b of staff) {
    for (const k of Object.keys(totals)) totals[k] += b[k] ?? 0;
  }
  totals.hours_worked = Number(totals.hours_worked.toFixed(1));
  totals.overtime_hours = Number((totals.overtime_min / 60).toFixed(1));
  totals.on_time_pct = roundPct(totals.on_time, totals.on_time + totals.tardy);

  return {
    period_days: periodDays,
    generated_at: new Date(effectiveNow).toISOString(),
    totals,
    staff,
  };
}
