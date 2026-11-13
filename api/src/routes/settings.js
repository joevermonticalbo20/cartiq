// Time clock settings (web dashboard → Settings → Time clock).
// GET: any signed-in role. PUT: OWNER only. Mirrors the Edge function.
import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  readTimeClock,
  writeTimeClock,
  canonicalHm,
  hmToMinutes,
  timeClockScheduleError,
} from "../services/time_clock.js";

const router = Router();

// GET /api/settings/timeclock -> { clock }
router.get("/timeclock", requireAuth, async (_req, res, next) => {
  try {
    return res.json({ clock: await readTimeClock() });
  } catch (err) {
    return next(err);
  }
});

// PUT /api/settings/timeclock (OWNER) -> { clock }
router.put(
  "/timeclock",
  requireAuth,
  requireRole("OWNER"),
  async (req, res, next) => {
    try {
      const body = req.body ?? {};
      const enabled = body.enabled === true;
      const inOpen = canonicalHm(body.inOpen);
      const inClose = canonicalHm(body.inClose);
      const outOpen = canonicalHm(body.outOpen);
      const outClose = canonicalHm(body.outClose);
      if (!inOpen || !inClose || !outOpen || !outClose) {
        return res.status(400).json({ error: 'Each time must be "HH:MM" (24h), e.g. "07:30".' });
      }
      if (hmToMinutes(inOpen) >= hmToMinutes(inClose)) {
        return res.status(400).json({ error: "Time in: the opening time must be before the closing time." });
      }
      if (hmToMinutes(outOpen) >= hmToMinutes(outClose)) {
        return res.status(400).json({ error: "Time out: the opening time must be before the closing time." });
      }
      // A shift must start before it can end: the Time out window may not be
      // earlier than the Time in window.
      const scheduleError = timeClockScheduleError({ inOpen, inClose, outOpen, outClose });
      if (scheduleError) {
        return res.status(400).json({ error: scheduleError });
      }
      const rawDays = body.days;
      let days;
      if (rawDays === undefined || rawDays === null) {
        // An older bundle that does not send days keeps the stored days
        // (every day for a fresh doc) - never a hard 400 mid-rollout.
        days = (await readTimeClock()).days;
      } else if (!Array.isArray(rawDays)) {
        return res.status(400).json({ error: "days must be a non-empty array of weekday numbers (0 = Sunday, 6 = Saturday)." });
      } else {
        days = [...new Set(rawDays.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort((a, b) => a - b);
        if (days.length === 0) {
          return res.status(400).json({ error: "days must not be empty - select at least one selling day." });
        }
      }
      const clock = await writeTimeClock(
        { enabled, inOpen, inClose, outOpen, outClose, days },
        req.user?.name ?? req.user?.username ?? null,
      );
      return res.json({ clock });
    } catch (err) {
      return next(err);
    }
  },
);

export default router;
