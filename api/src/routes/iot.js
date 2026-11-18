import { Router } from "express";
import { db as prisma } from "../firestore.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { requireDevice } from "../middleware/device.js";
import { manilaDayRange, manilaDayStart } from "../services/timezone.js";
import {
  duplicateShiftReason,
  manilaDayKeyOf,
  shiftsOfPersonOnDay,
} from "../services/shift_rules.js";
import { lowStockDedupeKey, shouldOpenLowStockAlert } from "../services/low_stock_alert.js";
import { notifyAssignedStaffOfLowStock } from "../services/staff_low_stock_notify.js";
import {
  cardBelongsToAnotherCart,
  cardLocationCode,
  classifyTap,
  lookupUid,
  normalizeRfidUid,
  wrongCartMessage,
  TAP_IGNORED,
  TAP_REGISTRATION,
} from "../services/rfid.js";
import { readTimeClock, timeClockVerdict } from "../services/time_clock.js";
import { scheduleVerdict, tapBadge, entryForInstant } from "../services/staff_schedule.js";
import { cleanEventId, resolveNextEvent, attendanceMethod } from "../services/attendance_core.js";
import { aggregateShiftReport } from "../services/shift_report.js";
import { loadScheduleMap } from "../services/staff_schedule_store.js";
import { CLAIM_BOUND, resolveClaim } from "../services/rfid_claims.js";
import { bindClaimedTag } from "../services/rfid_bind.js";
import { sendShiftPush, pushToOwners } from "../services/push.js";
import { emit } from "./events.js";

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
      return { accepted, rejected, newAlerts };
    });

    for (const low of outcome.newAlerts ?? []) {
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
        // Push must never fail a reading batch.
      }
    }
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
      const intent = classifyTap(bound);
      if (intent.kind === TAP_IGNORED) {
        // No claim pending at all: the reader can also be used as a bare clock
        // ("state-driven" attendance, the same next action the app would pick),
        // so a plain card tap signs the person in/out without opening the app.
        // A REFUSED claim still records nothing - that intent failed in the app,
        // the tap cannot undo it.
        if (!bound) e._bare = true;
        else e._ignore = true;
        if (bound) registrations.push(bound);
        continue;
      }
      registrations.push(bound);
      if (intent.kind === TAP_REGISTRATION) {
        // A registration-only tap: the card was enrolled, no shift.
        e._registrationOnly = true;
        continue;
      }
      // The person pressed Time In or Time Out in the app. The firmware only
      // knows how to toggle, and toggling would silently log someone OUT when
      // they meant to clock IN. The app's choice wins.
      e.event = intent.event;
    }

    // Weekly schedules for the tapped cards. Prefetched outside the txn
    // (tiny collection) so the gate below can refuse a tap outside the
    // person's scheduled window. Unscheduled staff stay unrestricted.
    const scheduleMap = await loadScheduleMap();

    // Same reads-first restructure as /iot/readings: users and unread
    // UNKNOWN_CARD alerts are prefetched, then shifts + alerts are written.
    // accepted/rejected live INSIDE the txn (see above) so contention
    // retries cannot duplicate response entries.
    const outcome = await prisma.runTransaction(async (tx) => {
      const accepted = [];
      const rejected = [];
      // ---- READ PHASE (users table is tiny; match UIDs in code) ----
      const [users, unreadCardAlerts, unreadTimeClockAlerts] = await Promise.all([
        tx.user.findMany(),
        tx.alert.findMany({ where: { type: "UNKNOWN_CARD", isRead: false } }),
        tx.alert.findMany({ where: { type: "TIMECLOCK_WINDOW", isRead: false } }),
      ]);
      // Idempotency guard for the reader's sync: a buffered offline tap that
      // is re-posted after a 4xx/5xx/retry must never write a second shift.
      const eventIdsInBatch = new Set();
      for (const e of rows) {
        const id = cleanEventId(e?.eventId ?? e?.event_id ?? "");
        if (id) eventIdsInBatch.add(id);
      }
      const alreadyProcessed = new Set();
      for (const id of eventIdsInBatch) {
        const guard = await tx.getDoc("shiftEvents", id).catch(() => null);
        if (guard) alreadyProcessed.add(id);
      }
      const unreadAlerts = [...unreadCardAlerts, ...unreadTimeClockAlerts];
      // Both sides of the comparison are normalized. A row stored before the
      // normalization fix (lowercase, or with separators a human pasted in)
      // would otherwise never match a tap and the card would silently become
      // an UNKNOWN_CARD alert forever.
      const byUid = new Map(
        users
          .filter((u) => u.rfidUid)
          .map((u) => [lookupUid(u.rfidUid), u]),
      );

      const clock = await readTimeClock();
      // ---- COMPUTE PHASE (same validation/messages as before) ----
      const plans = [];
      const createdNeedles = new Set();
      const newAlerts = [];
      // One IN and one OUT per person per Manila day. A tap on the reader
      // never goes through the app, so the app's own guard (the greyed button)
      // cannot be the only thing standing between a person and a duplicate
      // shift. Read this cart's recent shifts (today and yesterday, so a tap
      // stamped just before midnight still finds its neighbour) and check per
      // person, per day of the tap itself.
      const recentShifts = await tx.shift.findMany({
        where: { locationId: location.id, ts: { gte: manilaDayStart(1) } },
      });
      for (const e of rows) {
        const uid = String(e.staff_uid ?? "").trim();
        if (e._ignore || e._registrationOnly) continue;
        const bare = e._bare === true;
        const eventId = cleanEventId(e.eventId ?? e.event_id ?? "");
        // The reader re-sends buffered offline taps until it gets a 2xx.
        // A tap whose eventId was already processed is a no-op success.
        if (eventId && alreadyProcessed.has(eventId)) {
          accepted.push({ staff_uid: uid || null, event: String(e.event ?? "").toUpperCase() || "IN", matched: null, duplicate: true });
          continue;
        }
        let event = String(e.event ?? "").toUpperCase();
        if (!uid || uid.length > 64) {
          rejected.push({ staff_uid: uid || null, event: bare ? "AUTO" : event, reason: "invalid uid" });
          continue;
        }
        const ts = e.ts ? new Date(e.ts) : new Date();
        if (!Number.isFinite(ts.getTime())) {
          rejected.push({ staff_uid: uid || null, event, reason: "invalid ts" });
          continue;
        }
        if (bare) {
          // State-driven: the method never decides IN vs OUT, the day does.
          const probeUser = byUid.get(lookupUid(uid)) ?? null;
          if (probeUser) {
            const next = resolveNextEvent(
              shiftsOfPersonOnDay(recentShifts, {
                staffId: probeUser.id,
                staffUid: uid,
                dayKey: manilaDayKeyOf(ts),
              }),
            );
            if (!next.action) {
              rejected.push({ staff_uid: uid, event: "AUTO", reason: next.reason });
              continue;
            }
            event = next.action;
          } else {
            // Unknown card: travel through the normal UNKNOWN_CARD path as IN.
            event = "IN";
          }
        }
        if (!EVENTS.includes(event)) {
          rejected.push({ staff_uid: uid || null, event, reason: "invalid uid or event" });
          continue;
        }
        // Server-side backstop for the "Time in / Time out is greyed out in
        // the app" rule: a direct reader tap cannot check a button, so the
        // tap is refused here instead. The card still binds its registration
        // claim; only the shift is blocked.
        const verdict = timeClockVerdict(clock, event, ts.getTime());
        if (verdict) {
          rejected.push({ staff_uid: uid, event, reason: verdict });
          const dedupeKey = `timeclock:${location.id}:${event}`;
          const dup =
            createdNeedles.has(dedupeKey) ||
            unreadAlerts.some((a) => {
              try {
                if (JSON.parse(a.payload ?? "{}")?.dedupeKey === dedupeKey) return true;
              } catch {
                // fall through to the message check
              }
              return (a.message ?? "").includes(`outside the clock window`);
            });
          if (!dup) {
            createdNeedles.add(dedupeKey);
            const win = event === "OUT"
              ? `${clock.outOpen}-${clock.outClose}`
              : `${clock.inOpen}-${clock.inClose}`;
            newAlerts.push({
              type: "TIMECLOCK_WINDOW",
              message: `${event === "IN" ? "Time in" : "Time out"} blocked at ${location.code}: tapped outside the clock window ${win} (Manila) - no shift logged`,
              payload: JSON.stringify({
                dedupeKey,
                event,
                window: win,
                locationId: location.id,
                locationCode: location.code,
              }),
            });
          }
          continue;
        }
        const user = byUid.get(lookupUid(uid)) ?? null;
        // A deactivated account is not bookable — a tap cannot revive it.
        if (user && user.active === false) {
          rejected.push({ staff_uid: uid, event, reason: "Staff account is deactivated." });
          const dedupeKey = `inactive:${location.id}:${user.id}`;
          const dup =
            createdNeedles.has(dedupeKey) ||
            unreadAlerts.some((a) => {
              try {
                return JSON.parse(a.payload ?? "{}")?.dedupeKey === dedupeKey;
              } catch {
                return false;
              }
            });
          if (!dup) {
            createdNeedles.add(dedupeKey);
            newAlerts.push({
              type: "TIMECLOCK_WINDOW",
              message: `${event} blocked at ${location.code}: ${user.name}'s account is deactivated - no shift logged`,
              payload: JSON.stringify({ dedupeKey, event, staffId: user.id, locationId: location.id, locationCode: location.code }),
            });
          }
          continue;
        }
        // A card belongs to the cart where it was enrolled: each cart has its
        // own team, so a card enrolled at CART-01 does not clock in at
        // CART-02. The tap is refused and no shift is written.
        if (user && cardBelongsToAnotherCart(user, location.code)) {
          rejected.push({
            staff_uid: uid,
            event,
            reason: wrongCartMessage(cardLocationCode(user)),
          });
          continue;
        }
        // Weekly staff schedule (owner-managed roster): a tap outside the
        // person's scheduled window never logs a shift. The claim binds
        // either way; only the attendance log is refused, like the clock
        // window above. Unscheduled staff are unrestricted.
        if (user) {
          const sVerdict = scheduleVerdict(scheduleMap.get(user.id) ?? null, ts.getTime(), event);
          if (sVerdict.scheduled && sVerdict.ok === false) {
            rejected.push({ staff_uid: uid, event, reason: sVerdict.reason });
            const dedupeKey = `schedule:${location.id}:${user.id}:${event}`;
            const dup =
              createdNeedles.has(dedupeKey) ||
              unreadAlerts.some((a) => {
                try {
                  if (JSON.parse(a.payload ?? "{}")?.dedupeKey === dedupeKey) return true;
                } catch {}
                return false;
              });
            if (!dup) {
              createdNeedles.add(dedupeKey);
              newAlerts.push({
                type: "TIMECLOCK_WINDOW",
                message: `${event === "OUT" ? "Time out" : "Time in"} blocked at ${location.code}: ${sVerdict.reason}`,
                payload: JSON.stringify({
                  dedupeKey,
                  event,
                  staffId: user.id,
                  locationId: location.id,
                  locationCode: location.code,
                }),
              });
            }
            continue;
          }
        }
        // One IN and one OUT per person per Manila day. After a time in, the
        // next tap is a duplicate, not a new shift.
        if (user) {
          const dayKey = manilaDayKeyOf(ts);
          const todays = shiftsOfPersonOnDay(recentShifts, {
            staffId: user.id,
            staffUid: uid,
            dayKey,
          });
          const duplicate = duplicateShiftReason(todays, event);
          if (duplicate) {
            rejected.push({ staff_uid: uid, event, reason: duplicate });
            continue;
          }
        }
        plans.push({ uid, event, ts, user, eventId, method: "RFID" });
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
        // The owner wants a record when a real person clocks in or out at their
        // cart: a SHIFT alert lands in the notification center.
        if (user) {
          newAlerts.push({
            type: "SHIFT",
            message: `${user.name} ${event === "OUT" ? "timed out" : "timed in"} at ${location.code}`,
            payload: JSON.stringify({
              staffId: user.id,
              staffUid: uid,
              event,
              method: "RFID",
              locationId: location.id,
              locationCode: location.code,
              ts: ts.toISOString(),
            }),
            locationId: location.id,
            locationCode: location.code,
          });
        }
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
            method: plan.method,
            receivedAt: new Date(),
          },
        });
        // Mark this buffered tap as processed so a re-sync is a no-op.
        if (plan.eventId) {
          tx.setDoc("shiftEvents", plan.eventId, {
            eventId: plan.eventId,
            deviceId: req.device.deviceId,
            locationId: location.id,
            staffId: plan.user?.id ?? null,
            event: plan.event,
            at: new Date(),
          });
        }
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
      // When the shift was refused, hand the server's own words to the app
      // ("You already timed in today at 8:35 PM."). The app then says exactly
      // that, instead of a vague "card read, but no time-in recorded".
      const refused = written
        ? null
        : outcome.rejected.find(
            (r) => normalizeRfidUid(r.staff_uid ?? "") === reg.rfidUid,
          );
      resolveClaim(
        reg.claimId,
        CLAIM_BOUND,
        reg.rfidUid,
        null,
        written?.event ?? null,
        null,
        refused?.reason ?? null,
      );
    }

    // A deliberate tap must show up on the screens right away: publish it for
    // the SSE stream (the web dashboard) and push it to the devices (the POS
    // app). The app that asked for the shift hears about it through its claim,
    // the dashboard hears about it through the stream, and the owner hears
    // about it on their own phone.
    //
    // Who pressed the button for each tapped card: the claim opener. The owner
    // notice skips them - they just did it, they know.
    const actorByUid = new Map(
      registrations
        .filter((r) => r.outcome === "bound")
        .map((r) => [normalizeRfidUid(r.rfidUid), r.claimedBy ?? null]),
    );
    for (const acc of outcome.accepted) {
      const status = acc.matched ? "recorded" : "unregistered";
      emit("shift:new", {
        staff_uid: acc.staff_uid,
        event: acc.event,
        staff_name: acc.matched ?? null,
        location_code: location.code,
        status,
      });
      await sendShiftPush({
        event: acc.event,
        staffUid: acc.staff_uid,
        staffName: acc.matched ?? null,
        locationCode: location.code,
        status,
      });
      // The owner wants to know who clocked in at which cart, right away.
      if (acc.matched) {
        await pushToOwners({
          title: acc.event === "OUT" ? "Time out" : "Time in",
          body: `${acc.matched} ${acc.event === "OUT" ? "timed out" : "timed in"} at ${location.code}`,
          data: {
            event: acc.event,
            staffName: acc.matched,
            locationCode: location.code,
          },
          excludeUserId: actorByUid.get(normalizeRfidUid(acc.staff_uid)) ?? null,
        });
      }
    }
    for (const rej of outcome.rejected) {
      emit("shift:new", {
        staff_uid: rej.staff_uid ?? null,
        event: rej.event ?? "",
        staff_name: null,
        location_code: location.code,
        status: "refused",
        reason: rej.reason,
      });
      // No push for a refusal: the phone that asked for the shift gets the
      // server's reason through its claim (resolved above), and that is the
      // only phone that needs it. Pushing it as well would say the same words
      // twice on that phone - and once on every other phone, where nobody
      // asked for anything.
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
    // Owner Settings → Staff Accounts: a deactivated account is not bookable.
    if (user.active === false) {
      return res.status(400).json({ error: "Staff account is deactivated." });
    }
    if (!location) return res.status(404).json({ error: "Location not found" });
    // Owner Settings → Carts: only an ACTIVE cart can take the shift.
    if (location.status === "INACTIVE") {
      return res.status(400).json({ error: "Cart is deactivated. Pick an active cart." });
    }
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
        method: "MANUAL",
        receivedAt: new Date(),
      },
    });
    return res.status(201).json({ shift });
  } catch (err) {
    return next(err);
  }
});

// Shift logs are an append-only audit trail: PATCH and DELETE are refused
// outright — not even an OWNER may edit or remove a row. Corrections are made
// by appending a new manual entry (/shifts/manual), never by altering history.
router.patch("/shifts/:id", requireAuth, requireRole("OWNER"), (_req, res) =>
  res.status(403).json({ error: "Shift logs are append-only and cannot be edited or deleted" }));
router.delete("/shifts/:id", requireAuth, requireRole("OWNER"), (_req, res) =>
  res.status(403).json({ error: "Shift logs are append-only and cannot be edited or deleted" }));

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

// GET /api/shifts/report?days=28 — the Shift History report: attendance
// discipline vs the weekly roster, aggregated server-side over the shifts
// in the window (read-time, no schema change). OWNER only.
router.get("/shifts/report", requireAuth, requireRole("OWNER"), async (req, res, next) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 28, 1), 90);
    const code = String(req.query.code ?? "").trim().toUpperCase();
    const since = manilaDayStart(days - 1);
    const [shifts, users, scheduleMap] = await Promise.all([
      prisma.shift.findMany({
        where: { ts: { gte: since } },
        include: { location: { select: { code: true } } },
      }),
      prisma.user.findMany({
        where: { role: "STAFF" },
        include: { location: { select: { code: true } } },
      }),
      loadScheduleMap(),
    ]);
    // Cart filter: show only staff assigned to that cart (the report still
    // counts taps at any cart they work — assignment is the scope, not the tap).
    const staff = code
      ? users.filter((u) => String(u.location?.code ?? "").toUpperCase() === code)
      : users;
    return res.json(
      aggregateShiftReport({ shifts, staffUsers: staff, scheduleMap, days }),
    );
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
    const [total, shifts, scheduleMap] = await Promise.all([
      prisma.shift.count({ where }),
      prisma.shift.findMany({
        where,
        include: { location: { select: { code: true, name: true } } },
        orderBy: { ts: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      loadScheduleMap(),
    ]);
    const data = shifts.map((s) => {
      const raw = s.staffId != null ? scheduleMap.get(Number(s.staffId)) ?? null : null;
      // No schedule doc -> "No schedule" badge; scheduled day off -> "Not scheduled".
      const sched = raw ? entryForInstant(raw, s.ts) : undefined;
      let punctuality;
      if (sched === undefined) punctuality = { label: "No schedule", tone: "neutral" };
      else if (sched === null) punctuality = { label: "Not scheduled", tone: "neutral" };
      else punctuality = tapBadge({ event: s.event, instant: s.ts, entry: sched });
      return { ...s, punctuality, method: attendanceMethod(s) };
    });
    return res.json({
      data,
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

// POST /api/shifts/self (STAFF, user JWT) — "App Tap": the authenticated staff
// member records their own attendance from the app, no card needed. Same
// gates as the reader tap: session = identity, server stamps the time, the
// next action comes from their attendance state today (never from the
// caller). One IN and one OUT per Manila day per cart.
router.post("/shifts/self", requireAuth, requireRole("STAFF"), async (req, res, next) => {
  try {
    const staffId = Number(req.user.sub);
    const user = await prisma.user.findUnique({ where: { id: staffId } });
    if (!user) return res.status(404).json({ error: "Staff not found" });
    if (user.active === false) {
      return res.status(403).json({ error: "Staff account is deactivated." });
    }
    const location = user.locationId
      ? await prisma.location.findUnique({ where: { id: user.locationId } })
      : null;
    if (!location) {
      return res.status(403).json({ error: "No cart assigned yet - ask the owner to assign one." });
    }
    if (location.status === "INACTIVE") {
      return res.status(400).json({ error: "Cart is deactivated. Pick an active cart." });
    }
    const now = new Date();
    const todays = await prisma.shift.findMany({
      where: { locationId: location.id, ts: { gte: manilaDayStart(0) } },
    });
    const mine = shiftsOfPersonOnDay(todays, {
      staffId: user.id,
      staffUid: user.rfidUid ?? `APP-${user.id}`,
      dayKey: manilaDayKeyOf(now),
    });
    const next = resolveNextEvent(mine);
    if (!next.action) {
      return res.status(409).json({ error: next.reason });
    }
    const event = next.action;
    const clock = await readTimeClock();
    const verdict = timeClockVerdict(clock, event, Date.now());
    if (verdict) {
      return res.status(403).json({ error: verdict, code: "TIMECLOCK_LOCKED" });
    }
    const scheduleMap = await loadScheduleMap();
    const sVerdict = scheduleVerdict(scheduleMap.get(user.id) ?? null, Date.now(), event);
    if (sVerdict.scheduled && sVerdict.ok === false) {
      return res.status(403).json({ error: sVerdict.reason, code: "SCHEDULE_LOCKED" });
    }
    const [id] = await prisma.shift.nextIds(1);
    const shift = await prisma.shift.create({
      data: {
        id,
        staffUid: user.rfidUid ?? `APP-${user.id}`,
        staffId: user.id,
        staffName: user.name,
        locationId: location.id,
        event,
        ts: now,
        deviceId: "APP",
        method: "APP",
        receivedAt: now,
      },
    });
    // Same notification-center record as a reader tap, tagged APP.
    try {
      const alert = await prisma.alert.create({
        data: {
          type: "SHIFT",
          message: `${user.name} ${event === "OUT" ? "timed out" : "timed in"} at ${location.code}`,
          payload: JSON.stringify({
            staffId: user.id,
            staffUid: user.rfidUid ?? `APP-${user.id}`,
            event,
            method: "APP",
            locationId: location.id,
            locationCode: location.code,
            ts: now.toISOString(),
          }),
          locationId: location.id,
          locationCode: location.code,
        },
      });
      emit("alert:new", {
        id: alert.id,
        type: alert.type,
        userId: null,
        title: null,
        message: alert.message,
        isRead: false,
        createdAt: alert.createdAt,
        locationId: location.id,
      });
    } catch {
      // best-effort only
    }
    return res.status(201).json({ shift, event, method: "APP" });
  } catch (err) {
    return next(err);
  }
});

// GET /api/device-status - the cart reader's connectivity for the app's tap
// UI (the staff-safe subset of the OWNER /devices registry). Staff see their
// own cart; OWNER may pass ?code=CART-01 (defaults to the first active cart).
const DEVICE_ONLINE_MS = 120 * 1000;
router.get("/device-status", requireAuth, async (req, res, next) => {
  try {
    let location = null;
    if (req.user?.role === "OWNER") {
      const code = String(req.query.code ?? "").trim().toUpperCase();
      location = code
        ? await prisma.location.findUnique({ where: { code } })
        : (await prisma.location.findMany({ where: { status: "ACTIVE" } }))[0] ?? null;
      if (!location) return res.status(404).json({ error: "Cart not found" });
    } else {
      const locationId = req.user?.locationId;
      if (!locationId) return res.json({ cart: null, status: "unavailable", lastSeenSeconds: null });
      location = await prisma.location.findUnique({ where: { id: locationId } });
    }
    const device = await prisma.device.findFirst({
      where: { locationId: location.id, active: true },
      orderBy: { lastSeenAt: "desc" },
    });
    if (!device?.lastSeenAt) {
      return res.json({ cart: location.code, status: "unavailable", lastSeenSeconds: null });
    }
    const secs = Math.round((Date.now() - new Date(device.lastSeenAt).getTime()) / 1000);
    return res.json({
      cart: location.code,
      status: secs * 1000 < DEVICE_ONLINE_MS ? "connected" : "offline",
      lastSeenSeconds: secs,
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
