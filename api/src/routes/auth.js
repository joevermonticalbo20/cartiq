import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import { db as prisma } from "../firestore.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  normalizeEmail,
  validEmail,
  generateOtp,
  hashOtp,
  otpMatches,
  otpPurpose,
  isPlaceholderEmail,
  maskEmail,
  OTP_TTL_MS,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_MS,
  OTP_PURPOSE_RESET,
  OTP_PURPOSE_CHANGE,
  FORGOT_GENERIC_MESSAGE,
  RESET_INVALID_MESSAGE,
  CHANGE_INVALID_MESSAGE,
  APP_UPDATE_REQUIRED_MESSAGE,
  RECOVERY_EMAIL_REQUIRED_MESSAGE,
} from "../services/password_reset.js";
import { emailStatus, sendOtpEmail } from "../services/gmail.js";
import {
  LOGIN_IP_MAX_ATTEMPTS,
  LOGIN_IP_WINDOW_MS,
  formatRetryAfter,
  lockRemainingMs,
  loginAttemptKey,
  loginLockMessage,
  normalizeLoginUsername,
  registerLoginFailure,
  retryAfterSeconds,
} from "../services/login_lockout.js";
import { cleanRfidUid, normalizeRfidUid } from "../services/rfid.js";
import { readTimeClock, timeClockVerdict } from "../services/time_clock.js";
import { openClaim, getClaim, claimView } from "../services/rfid_claims.js";
import { emit } from "./events.js";

// Coarse per-IP spray guard, mirroring the Edge function. The real
// credential guard is the persistent per-username lock in
// services/login_lockout.js (5 failures -> 5-minute wait). This map only
// stops one host trying many different accounts and runs before the
// per-username Firestore read.
const loginIpWindows = new Map();
function loginIpAllowed(ip, now = Date.now()) {
  const key = ip || "unknown";
  let rec = loginIpWindows.get(key);
  if (!rec || rec.resetAtMs <= now) {
    rec = { count: 0, resetAtMs: now + LOGIN_IP_WINDOW_MS };
    loginIpWindows.set(key, rec);
  }
  if (loginIpWindows.size > 2000 && Math.random() < 0.01) {
    for (const [k, v] of loginIpWindows) {
      if (v.resetAtMs <= now) loginIpWindows.delete(k);
    }
  }
  if (rec.count >= LOGIN_IP_MAX_ATTEMPTS) {
    return {
      allowed: false,
      retryAfterSeconds: retryAfterSeconds(rec.resetAtMs - now),
    };
  }
  rec.count++;
  return { allowed: true, retryAfterSeconds: 0 };
}

function loginAttemptRef(username) {
  return prisma.collection("loginAttempts").doc(loginAttemptKey(username));
}

async function recordLoginFailure(username, now) {
  // Firestore transaction: parallel wrong passwords cannot all read the same
  // count and slip past the limit. runTransaction retries on contention.
  return prisma.runTransaction(async (tx) => {
    const current = await tx.getDoc(
      "loginAttempts",
      loginAttemptKey(username)
    );
    const next = registerLoginFailure(current, now);
    tx.setDoc("loginAttempts", loginAttemptKey(username), next);
    return next;
  });
}

// Forgot-password: 5 requests/hour per IP+email. Keyed on both so one actor
// can't burn the quota for someone else's address from a shared network,
// and one address can't be spammed from rotating IPs beyond the DB-level
// 60s resend cooldown + 5-attempt code cap.
const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => `${req.ip ?? ""}|${normalizeEmail(req.body?.email)}`,
  message: { error: "Too many reset requests - please try again later" },
});

// Reset-password: looser (legit typo retries), the per-code attempt cap is
// the real brute-force guard.
const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: "Too many reset attempts - please try again later" },
});

// Authenticated password/profile checks: keyed on IP + account so one shared
// cart network cannot exhaust another account's budget. The 60s OTP cooldown
// is separate and enforced against the latest record.
const changeOtpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => `${req.ip ?? ""}|${req.user?.sub ?? ""}`,
  message: { error: "Too many code requests - please try again later" },
});
const passwordCheckLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => `${req.ip ?? ""}|${req.user?.sub ?? ""}`,
  message: { error: "Too many attempts - please try again later" },
});

const router = Router();

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    role: user.role,
    email: user.email ?? null,
    // Normalized on read so a row stored before the normalization fix still
    // matches a tap. Clients use this to decide whether to prompt for a tag.
    rfidUid: user.rfidUid ? normalizeRfidUid(user.rfidUid) : null,
    location: user.location
      ? { id: user.location.id, code: user.location.code, name: user.location.name }
      : null,
  };
}

router.post("/login", async (req, res, next) => {
  try {
    const { username, password } = req.body ?? {};
    if (!username || !password) {
      return res.status(400).json({ error: "username and password are required" });
    }
    // Usernames are matched trimmed (the POS keyboard may add spaces).
    const cleanUsername = normalizeLoginUsername(username);
    const now = Date.now();

    // Coarse per-IP spray guard BEFORE the Firestore read, so a host that
    // keeps hammering a blocked or random username cannot burn the Spark
    // read quota. The persistent per-username lock below is the real
    // credential guard; this tier only stops username spraying.
    const ipCheck = loginIpAllowed(req.ip, now);
    if (!ipCheck.allowed) {
      res.set("Retry-After", String(ipCheck.retryAfterSeconds));
      return res.status(429).json({
        error: `Too many login attempts. Wait ${formatRetryAfter(ipCheck.retryAfterSeconds)} and try again.`,
        code: "LOGIN_RATE_LIMITED",
        retryAfterSeconds: ipCheck.retryAfterSeconds,
      });
    }

    // The lock applies even when the password is correct. It is stored in
    // Firestore so a cold start, another Edge isolate, or another device
    // cannot reset the five-minute wait.
    const attemptSnap = await loginAttemptRef(cleanUsername).get();
    const attemptState = attemptSnap.exists ? attemptSnap.data() : null;
    const remainingMs = lockRemainingMs(attemptState, now);
    if (remainingMs > 0) {
      const wait = retryAfterSeconds(remainingMs);
      res.set("Retry-After", String(wait));
      return res.status(429).json({
        error: loginLockMessage(wait),
        code: "LOGIN_LOCKED",
        retryAfterSeconds: wait,
        lockedUntil: new Date(Number(attemptState.lockedUntilMs)).toISOString(),
      });
    }

    // One message for every credential failure: distinct "disabled account"
    // vs "bad password" responses let attackers enumerate accounts.
    const rejectCredentials = async () => {
      const next = await recordLoginFailure(cleanUsername, now);
      const body = {
        error: "Invalid credentials",
        attemptsRemaining: next.attemptsRemaining,
      };
      if (next.locked && next.lockedUntilMs > now) {
        body.retryAfterSeconds = retryAfterSeconds(next.lockedUntilMs - now);
        body.lockedUntil = new Date(next.lockedUntilMs).toISOString();
      }
      return res.status(401).json(body);
    };

    const user = await prisma.user.findUnique({
      where: { username: cleanUsername },
      include: { location: true },
    });
    if (!user || user.active === false) {
      return rejectCredentials();
    }
    if (!(await bcrypt.compare(password, user.passwordHash))) {
      return rejectCredentials();
    }

    // Successful login clears the run. Delete is idempotent and best-effort:
    // a cleanup failure must never block a valid sign-in.
    await loginAttemptRef(cleanUsername).delete().catch(() => {});

    const accessToken = jwt.sign(
      { sub: user.id, username: user.username, role: user.role, name: user.name, type: "access" },
      process.env.JWT_SECRET,
      { expiresIn: "15m" }
    );
    const refreshToken = jwt.sign(
      // jti guarantees uniqueness: without it, two logins in the same
      // second produce byte-identical JWTs and collide on token UNIQUE.
      // type separates refresh from access so one can never pass as the other.
      { sub: user.id, username: user.username, role: user.role, name: user.name, type: "refresh", jti: crypto.randomUUID() },
      process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );
    await prisma.refreshToken.create({
      data: {
        token: refreshToken,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        userId: user.id,
      },
    });
    return res.json({ token: accessToken, refreshToken, user: publicUser(user) });
  } catch (err) {
    return next(err);
  }
});

router.get("/me", requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.sub },
      include: { location: true },
    });
    if (!user) return res.status(404).json({ error: "User not found" });
    return res.json({ user: publicUser(user) });
  } catch (err) {
    return next(err);
  }
});

// PATCH /auth/me { email, currentPassword } - change your own recovery email.
// The current password is required so a stolen session cannot silently point
// recovery at another inbox. Placeholder addresses are not accepted here.
router.patch("/me", requireAuth, passwordCheckLimiter, async (req, res, next) => {
  try {
    const { email, currentPassword } = req.body ?? {};
    if (!currentPassword) {
      return res.status(400).json({ error: "currentPassword is required" });
    }
    const user = await prisma.user.findUnique({
      where: { id: req.user.sub },
      include: { location: true },
    });
    if (!user) return res.status(404).json({ error: "User not found" });
    if (!(await bcrypt.compare(String(currentPassword), user.passwordHash))) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }
    const cleanEmail = normalizeEmail(email);
    if (!cleanEmail || !validEmail(cleanEmail)) {
      return res.status(400).json({ error: "A valid email address is required" });
    }
    if (isPlaceholderEmail(cleanEmail)) {
      return res.status(400).json({ error: "Enter a real email address, not a placeholder" });
    }
    if (cleanEmail === normalizeEmail(user.email)) {
      return res.json({ user: publicUser(user) });
    }
    const taken = await prisma.user.findFirst({
      where: { email: cleanEmail, id: { not: user.id } },
    });
    if (taken) return res.status(409).json({ error: "Email already registered" });
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { email: cleanEmail },
      include: { location: true },
    });
    // A code sent to the old address must not still be redeemable after the
    // account points recovery somewhere else.
    await prisma.passwordReset.deleteMany({ where: { userId: user.id } });
    console.log(`[api:profile] recovery email updated for user #${user.id}`);
    return res.json({ user: publicUser(updated) });
  } catch (err) {
    return next(err);
  }
});

// ============================================================================
// RFID self-service: register the card a staff member uses for IN/OUT taps.
//
// The reader (ESP32 + MFRC522) only ever reports a tag UID - it has no idea
// who is holding the card. So the app, which knows the signed-in user, opens a
// short-lived claim on its cart first; the next tap on that cart's reader
// resolves it. GET /my-rfid/claim/:id lets the app poll for the outcome.
//
// These routes are for the account owner. An owner reassigning somebody else's
// tag stays on PATCH /auth/staff/:id.
// ============================================================================

// GET /api/auth/my-rfid (Bearer) -> { rfidUid }
router.get("/my-rfid", requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
    if (!user) return res.status(404).json({ error: "User not found" });
    return res.json({ rfidUid: user.rfidUid ? normalizeRfidUid(user.rfidUid) : null });
  } catch (err) {
    return next(err);
  }
});

// POST /api/auth/my-rfid/claim (Bearer)
// Body: { locationCode? } - optional for STAFF (their own cart), required for
// OWNER, who is not assigned to a cart.
router.post("/my-rfid/claim", requireAuth, async (req, res, next) => {
  try {
    const { locationCode, event } = req.body ?? {};
    // null = enrolling a card only. IN/OUT = the person is clocking on or off,
    // and the tap must record that instead of the firmware's blind toggle.
    let cleanEvent = null;
    if (event !== undefined && event !== null && String(event).trim() !== "") {
      cleanEvent = String(event).trim().toUpperCase();
      if (!["IN", "OUT"].includes(cleanEvent)) {
        return res.status(400).json({ error: 'event must be "IN" or "OUT"' });
      }
      const clock = await readTimeClock();
      const verdict = timeClockVerdict(clock, cleanEvent, Date.now());
      if (verdict) {
        return res.status(403).json({ error: verdict, code: "TIMECLOCK_LOCKED" });
      }
    }
    let location;
    if (locationCode !== undefined && locationCode !== null && String(locationCode).trim() !== "") {
      location = await prisma.location.findUnique({
        where: { code: String(locationCode).trim().toUpperCase() },
      });
      if (!location) return res.status(404).json({ error: "Location not found" });
      // A STAFF member may only claim on their own cart: otherwise any account
      // could aim a registration at a cart it has no shift access to.
      if (req.user.role !== "OWNER" && req.user.locationId !== location.id) {
        return res.status(403).json({ error: "Forbidden: you can only register on your own cart" });
      }
    } else if (req.user.locationId) {
      location = await prisma.location.findUnique({ where: { id: req.user.locationId } });
    }
    if (!location) {
      return res.status(400).json({
        error: "locationCode is required - you are not assigned to a cart",
      });
    }
    const claim = openClaim({
      userId: req.user.sub,
      locationId: location.id,
      locationCode: location.code,
      event: cleanEvent,
    });
    return res.status(201).json({ claim: claimView(claim) });
  } catch (err) {
    return next(err);
  }
});

// GET /api/auth/my-rfid/claim/:claimId (Bearer) -> { status, rfidUid, ... }
router.get("/my-rfid/claim/:claimId", requireAuth, async (req, res, next) => {
  try {
    const claim = getClaim(String(req.params.claimId));
    // Unknown and someone-else's claim are answered identically so a claim id
    // cannot be used to probe for other users' registrations.
    if (!claim || claim.userId !== req.user.sub) {
      return res.status(404).json({ error: "Claim not found" });
    }
    return res.json({ claim: claimView(claim) });
  } catch (err) {
    return next(err);
  }
});

// DELETE /api/auth/my-rfid (Bearer) -> unbind this account's own tag
router.delete("/my-rfid", requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
    if (!user) return res.status(404).json({ error: "User not found" });
    const previous = user.rfidUid ? normalizeRfidUid(user.rfidUid) : null;
    if (!previous) {
      return res.json({ rfidUid: null, removed: false });
    }
    await prisma.user.update({ where: { id: user.id }, data: { rfidUid: null } });
    emit("rfid:unbound", {
      userId: user.id,
      name: user.name,
      username: user.username,
      rfidUid: previous,
    });
    return res.json({ rfidUid: null, removed: true });
  } catch (err) {
    return next(err);
  }
});

router.post("/refresh", async (req, res, next) => {
  try {
    const { refreshToken } = req.body ?? {};
    if (!refreshToken) {
      return res.status(400).json({ error: "Refresh token is required" });
    }
    let payload;
    try {
      payload = jwt.verify(
        refreshToken,
        process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
        { algorithms: ["HS256"] }
      );
      if (!payload || payload.type !== "refresh") {
        return res.status(401).json({ error: "Invalid or expired refresh token" });
      }
    } catch {
      return res.status(401).json({ error: "Invalid or expired refresh token" });
    }
    const tokenRecord = await prisma.refreshToken.findUnique({
      where: { token: refreshToken },
    });
    if (!tokenRecord) return res.status(401).json({ error: "Invalid refresh token record" });
    if (new Date() > tokenRecord.expiresAt) {
      return res.status(401).json({ error: "Refresh token expired" });
    }
    // Rotate token: revoke old one, issue new one. The delete can lose a
    // same-token parallel race (already rotated) — that is a safe 401, not
    // a 500/404: the other rotation won and the client should use it.
    try {
      await prisma.refreshToken.delete({ where: { id: tokenRecord.id } });
    } catch (err) {
      if (err?.code === "P2025") {
        return res.status(401).json({ error: "Session already refreshed - please use the latest tokens" });
      }
      throw err;
    }

    const user = await prisma.user.findUnique({
      where: { id: tokenRecord.userId },
      include: { location: true },
    });
    if (!user) return res.status(404).json({ error: "User not found" });
    if (user.active === false) {
      return res.status(401).json({ error: "Account disabled" });
    }

    const newAccessToken = jwt.sign(
      { sub: user.id, username: user.username, role: user.role, name: user.name, type: "access" },
      process.env.JWT_SECRET,
      { expiresIn: "15m" }
    );
    const newRefreshToken = jwt.sign(
      // jti: see login route - same-second rotations must not collide.
      { sub: user.id, username: user.username, role: user.role, name: user.name, type: "refresh", jti: crypto.randomUUID() },
      process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );
    await prisma.refreshToken.create({
      data: {
        token: newRefreshToken,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        userId: user.id,
      },
    });

    return res.json({ token: newAccessToken, refreshToken: newRefreshToken, user: publicUser(user) });
  } catch (err) {
    return next(err);
  }
});

// POST /auth/logout - revoke a refresh token (idempotent, public so an
// expired access token can still log out). Web/mobile clear local session
// after calling this; server record is deleted so a stolen refresh dies.
router.post("/logout", async (req, res, next) => {
  try {
    const { refreshToken } = req.body ?? {};
    if (!refreshToken) return res.json({ loggedOut: true });
    const tokenRecord = await prisma.refreshToken.findUnique({
      where: { token: refreshToken },
    });
    if (tokenRecord) {
      await prisma.refreshToken.delete({ where: { id: tokenRecord.id } });
    }
    return res.json({ loggedOut: true });
  } catch (err) {
    return next(err);
  }
});

// POST /auth/forgot-password { email } -> generic success always.
// Flow: Gmail address in -> 6-digit OTP out (email delivery). The response
// is IDENTICAL whether or not the address maps to an account, so the
// endpoint can't enumerate registered emails. Disabled accounts are treated
// exactly like unknown ones (no email, same response).
router.post("/forgot-password", forgotLimiter, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    // Format errors are safe to report: validity reveals nothing about
    // whether an account exists.
    if (!email || !validEmail(email)) {
      return res.status(400).json({ error: "A valid email address is required" });
    }
    const user = await prisma.user.findUnique({ where: { email } });
    if (user && user.active !== false) {
      // Single active OTP per user: drop previous unused ones first, then
      // enforce the silent 60s resend cooldown (same generic response either
      // way — a 429 here would leak that the account exists).
      const existing = await prisma.passwordReset.findMany({
        where: { userId: user.id },
      });
      const unused = existing
        .filter((r) => !r.used)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      // Only a recent RESET code starts the cooldown. A just-issued change
      // code should not silently block the forgot flow.
      const fresh = unused.find((r) => otpPurpose(r) === OTP_PURPOSE_RESET);
      const coolingDown =
        fresh && Date.now() - new Date(fresh.createdAt).getTime() < OTP_RESEND_COOLDOWN_MS;
      if (!coolingDown) {
        for (const r of unused) {
          await prisma.passwordReset.delete({ where: { id: r.id } });
        }
        const code = generateOtp();
        await prisma.passwordReset.create({
          data: {
            userId: user.id,
            email,
            purpose: OTP_PURPOSE_RESET,
            tokenHash: hashOtp(code),
            expiresAt: new Date(Date.now() + OTP_TTL_MS),
          },
        });
        try {
          await sendOtpEmail({ to: email, code, purpose: OTP_PURPOSE_RESET });
        } catch (err) {
          // Delivery failure must not reveal anything: log server-side and
          // keep the generic response. The unsent code simply expires.
          console.error(`[api:forgot-password] email delivery failed for user #${user.id}:`, err.message);
        }
      }
    }
    return res.json({ success: true, message: FORGOT_GENERIC_MESSAGE });
  } catch (err) {
    return next(err);
  }
});

// POST /auth/reset-password { email, code, newPassword }.
// Every failure mode returns the SAME message + status so wrong codes,
// expired codes, exhausted attempts, and unknown emails are
// indistinguishable (no oracle for guessing).
router.post("/reset-password", resetLimiter, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const code = String(req.body?.code ?? "").trim();
    const { newPassword } = req.body ?? {};
    if (!email || !validEmail(email) || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: RESET_INVALID_MESSAGE });
    }
    if (
      !newPassword ||
      String(newPassword).length < 6 ||
      Buffer.byteLength(String(newPassword)) > 72
    ) {
      return res.status(400).json({ error: "newPassword must be 6-72 chars" });
    }
    const user = await prisma.user.findUnique({ where: { email } });
    const fail = () => res.status(400).json({ error: RESET_INVALID_MESSAGE });
    if (!user || user.active === false) return fail();
    const records = await prisma.passwordReset.findMany({
      where: { userId: user.id },
    });
    const rec = records
      .filter((r) => !r.used && otpPurpose(r) === OTP_PURPOSE_RESET)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
    if (!rec) return fail();
    if (new Date() > new Date(rec.expiresAt)) {
      await prisma.passwordReset.delete({ where: { id: rec.id } });
      return fail();
    }
    if ((rec.attempts ?? 0) >= OTP_MAX_ATTEMPTS) {
      await prisma.passwordReset.delete({ where: { id: rec.id } });
      return fail();
    }
    if (!otpMatches(code, rec.tokenHash)) {
      const attempts = (rec.attempts ?? 0) + 1;
      if (attempts >= OTP_MAX_ATTEMPTS) {
        await prisma.passwordReset.delete({ where: { id: rec.id } });
      } else {
        await prisma.passwordReset.update({
          where: { id: rec.id },
          data: { attempts },
        });
      }
      return fail();
    }
    // Correct code: consume it, set the password, kill every session and any
    // other outstanding OTPs for this user.
    await prisma.passwordReset.delete({ where: { id: rec.id } });
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await bcrypt.hash(String(newPassword), 10) },
    });
    await prisma.refreshToken.deleteMany({ where: { userId: user.id } });
    const leftovers = await prisma.passwordReset.findMany({
      where: { userId: user.id },
    });
    for (const r of leftovers.filter((x) => !x.used)) {
      await prisma.passwordReset.delete({ where: { id: r.id } });
    }
    return res.json({ updated: true, sessionsRevoked: true });
  } catch (err) {
    return next(err);
  }
});

// POST /auth/verify-reset-code { email, code } -> { valid: true }.
// Lets the recovery UI confirm the code BEFORE showing the new-password
// step, without consuming it (redemption still happens exactly once in
// POST /auth/reset-password). Wrong guesses count toward the same
// per-code attempt cap, so this adds no guessing oracle beyond the
// rate limit both endpoints share. All failures share one message.
router.post("/verify-reset-code", resetLimiter, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const code = String(req.body?.code ?? "").trim();
    const fail = () => res.status(400).json({ error: RESET_INVALID_MESSAGE });
    if (!email || !validEmail(email) || !/^\d{6}$/.test(code)) return fail();
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || user.active === false) return fail();
    const records = await prisma.passwordReset.findMany({
      where: { userId: user.id },
    });
    const rec = records
      .filter((r) => !r.used && otpPurpose(r) === OTP_PURPOSE_RESET)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
    if (!rec) return fail();
    if (new Date() > new Date(rec.expiresAt)) {
      await prisma.passwordReset.delete({ where: { id: rec.id } });
      return fail();
    }
    if ((rec.attempts ?? 0) >= OTP_MAX_ATTEMPTS) {
      await prisma.passwordReset.delete({ where: { id: rec.id } });
      return fail();
    }
    if (!otpMatches(code, rec.tokenHash)) {
      const attempts = (rec.attempts ?? 0) + 1;
      if (attempts >= OTP_MAX_ATTEMPTS) {
        await prisma.passwordReset.delete({ where: { id: rec.id } });
      } else {
        await prisma.passwordReset.update({
          where: { id: rec.id },
          data: { attempts },
        });
      }
      return fail();
    }
    return res.json({ valid: true });
  } catch (err) {
    return next(err);
  }
});

// GET /auth/gmail-status (OWNER) - diagnostics for the OTP sender.
// Reports the provider, presence booleans, and a live Gmail token-exchange
// check, never secret values. Use this first when reset emails don't arrive.
router.get("/gmail-status", requireAuth, requireRole("OWNER"), async (_req, res, next) => {
  try {
    return res.json(await emailStatus());
  } catch (err) {
    return next(err);
  }
});

// Provider-neutral alias for the same diagnostics.
router.get("/email-status", requireAuth, requireRole("OWNER"), async (_req, res, next) => {
  try {
    return res.json(await emailStatus());
  } catch (err) {
    return next(err);
  }
});

// POST /auth/change-password/otp (Bearer) - send the second-factor code to
// the signed-in account's recovery email. Unlike forgot-password this is
// authenticated, so it can say plainly when no real email is on file.
router.post("/change-password/otp", requireAuth, changeOtpLimiter, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
    if (!user) return res.status(404).json({ error: "User not found" });
    const email = normalizeEmail(user.email);
    if (!email || !validEmail(email) || isPlaceholderEmail(email)) {
      return res.status(400).json({ error: RECOVERY_EMAIL_REQUIRED_MESSAGE });
    }

    const records = await prisma.passwordReset.findMany({
      where: { userId: user.id },
    });
    const unused = records.filter((r) => !r.used);
    const freshChange = unused
      .filter((r) => otpPurpose(r) === OTP_PURPOSE_CHANGE)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
    if (
      freshChange &&
      Date.now() - new Date(freshChange.createdAt).getTime() < OTP_RESEND_COOLDOWN_MS
    ) {
      const retryAfterMs =
        OTP_RESEND_COOLDOWN_MS -
        (Date.now() - new Date(freshChange.createdAt).getTime());
      return res.json({
        sent: true,
        cooldown: true,
        retryAfterMs,
        email: maskEmail(email),
        message: "A code was sent recently. Check your inbox.",
      });
    }

    // One live OTP per account: a new change code also invalidates any reset
    // code, matching the single-active-code rule of the forgot flow.
    for (const r of unused) {
      await prisma.passwordReset.delete({ where: { id: r.id } });
    }
    const code = generateOtp();
    const rec = await prisma.passwordReset.create({
      data: {
        userId: user.id,
        email,
        purpose: OTP_PURPOSE_CHANGE,
        tokenHash: hashOtp(code),
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
      },
    });
    try {
      await sendOtpEmail({ to: email, code, purpose: OTP_PURPOSE_CHANGE });
    } catch (err) {
      // The user is authenticated and expects delivery: unlike forgot-password
      // we can report the failure instead of pretending success. Remove the
      // unusable code so a later retry is not blocked by the cooldown.
      await prisma.passwordReset.delete({ where: { id: rec.id } }).catch(() => {});
      console.error(`[api:change-password-otp] email delivery failed for user #${user.id}:`, err.message);
      return res.status(503).json({
        error: "Email delivery is not available right now. Please try again later.",
      });
    }
    return res.json({
      sent: true,
      email: maskEmail(email),
      expiresInMinutes: 10,
      message: "A 6-digit code was sent to your recovery email.",
    });
  } catch (err) {
    return next(err);
  }
});

// POST /auth/change-password { currentPassword, newPassword, code }.
// The code is the second factor: a signed-in session alone is not enough to
// replace the password. Old app builds omit it; they get a clear update hint.
router.post("/change-password", requireAuth, passwordCheckLimiter, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body ?? {};
    const code = String(req.body?.code ?? "").trim();
    // bcrypt truncates past 72 bytes: reject long passwords instead of
    // silently weakening them.
    if (
      !currentPassword ||
      !newPassword ||
      String(newPassword).length < 6 ||
      Buffer.byteLength(String(newPassword)) > 72
    ) {
      return res.status(400).json({ error: "currentPassword and newPassword (6-72 chars) are required" });
    }
    if (!code) {
      return res.status(400).json({ error: APP_UPDATE_REQUIRED_MESSAGE });
    }
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: CHANGE_INVALID_MESSAGE });
    }
    const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
    if (!user) return res.status(404).json({ error: "User not found" });
    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }
    const records = await prisma.passwordReset.findMany({
      where: { userId: user.id },
    });
    const rec = records
      .filter((r) => !r.used && otpPurpose(r) === OTP_PURPOSE_CHANGE)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
    const fail = () => res.status(400).json({ error: CHANGE_INVALID_MESSAGE });
    if (!rec) return fail();
    if (new Date() > new Date(rec.expiresAt)) {
      await prisma.passwordReset.delete({ where: { id: rec.id } });
      return fail();
    }
    if ((rec.attempts ?? 0) >= OTP_MAX_ATTEMPTS) {
      await prisma.passwordReset.delete({ where: { id: rec.id } });
      return fail();
    }
    if (!otpMatches(code, rec.tokenHash)) {
      const attempts = (rec.attempts ?? 0) + 1;
      if (attempts >= OTP_MAX_ATTEMPTS) {
        await prisma.passwordReset.delete({ where: { id: rec.id } });
      } else {
        await prisma.passwordReset.update({
          where: { id: rec.id },
          data: { attempts },
        });
      }
      return fail();
    }
    await prisma.passwordReset.delete({ where: { id: rec.id } });
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await bcrypt.hash(newPassword, 10) },
    });
    // Revoke every session: a stolen refresh token must die with the old
    // password. Note the current access JWT stays valid up to 15m; clients
    // should drop local tokens and re-login immediately after this call.
    await prisma.refreshToken.deleteMany({ where: { userId: user.id } });
    const leftovers = await prisma.passwordReset.findMany({
      where: { userId: user.id },
    });
    for (const r of leftovers.filter((x) => !x.used)) {
      await prisma.passwordReset.delete({ where: { id: r.id } });
    }
    return res.json({ updated: true, sessionsRevoked: true });
  } catch (err) {
    return next(err);
  }
});

// ---------------- staff management (OWNER only) ----------------

router.get("/staff", requireAuth, requireRole("OWNER"), async (_req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      include: { location: { select: { code: true, name: true } } },
      orderBy: [{ role: "desc" }, { username: "asc" }],
    });
    return res.json({
      data: users.map((u) => ({
        id: u.id,
        name: u.name,
        username: u.username,
        role: u.role,
        active: u.active,
        rfidUid: u.rfidUid,
        email: u.email ?? null,
        location: u.location ? { code: u.location.code, name: u.location.name } : null,
        createdAt: u.createdAt,
      })),
    });
  } catch (err) {
    return next(err);
  }
});

router.post("/staff", requireAuth, requireRole("OWNER"), async (req, res, next) => {
  try {
    const { name, username, password, locationCode, rfidUid, email, role } = req.body ?? {};
    const cleanRole = String(role ?? "STAFF").trim().toUpperCase();
    if (cleanRole !== "STAFF" && cleanRole !== "OWNER") {
      return res.status(400).json({ error: "role must be STAFF or OWNER" });
    }
    const cleanUsername = String(username ?? "").trim();
    if (!name || !cleanUsername || !password || String(password).length < 6) {
      return res.status(400).json({ error: "name, username and password (min 6 chars) required" });
    }
    if (Buffer.byteLength(String(password)) > 72) {
      return res.status(400).json({ error: "password must be 6-72 chars (bcrypt limit)" });
    }
    const exists = await prisma.user.findUnique({ where: { username: cleanUsername } });
    if (exists) return res.status(409).json({ error: `Username "${cleanUsername}" already exists` });

    // Email is optional (recovery via Gmail OTP needs one on file). Stored
    // lowercase; empty string clears to null.
    let cleanEmail = null;
    if (email !== undefined && email !== null && String(email).trim() !== "") {
      cleanEmail = normalizeEmail(email);
      if (!validEmail(cleanEmail)) {
        return res.status(400).json({ error: "email must be a valid email address" });
      }
      const emailTaken = await prisma.user.findUnique({ where: { email: cleanEmail } });
      if (emailTaken) return res.status(409).json({ error: "Email already registered" });
    }

    let locationId = null;
    // Owners have full access; cart assignment and RFID are staff-only.
    if (cleanRole === "STAFF" && locationCode) {
      const loc = await prisma.location.findUnique({ where: { code: String(locationCode) } });
      if (!loc) return res.status(404).json({ error: "Location not found" });
      locationId = loc.id;
    }
    // Normalize to the form the reader emits (zero-padded uppercase hex) so a
    // later tap matches. An unparseable uid is rejected outright rather than
    // stored, otherwise it would read as registered and never match a tap.
    let cleanRfid = null;
    if (cleanRole === "STAFF" && rfidUid !== undefined && rfidUid !== null && String(rfidUid).trim() !== "") {
      cleanRfid = cleanRfidUid(rfidUid);
      if (!cleanRfid) {
        return res.status(400).json({
          error: "rfidUid must be 4-10 bytes of hex, e.g. 04A2B3C4",
        });
      }
      const uidTaken = await prisma.user.findUnique({ where: { rfidUid: cleanRfid } });
      if (uidTaken) return res.status(409).json({ error: "RFID UID already registered" });
    }

    const user = await prisma.user.create({
      data: {
        name,
        username: cleanUsername,
        passwordHash: await bcrypt.hash(String(password), 10),
        role: cleanRole,
        active: true,
        locationId,
        rfidUid: cleanRfid,
        email: cleanEmail,
      },
    });
    return res.status(201).json({ user: { id: user.id, username: user.username, name: user.name, role: user.role, active: user.active, email: user.email ?? null } });
  } catch (err) {
    return next(err);
  }
});

router.patch("/staff/:id", requireAuth, requireRole("OWNER"), async (req, res, next) => {
  try {
    const { active, password, name, username, locationCode, rfidUid, email } = req.body ?? {};
    const user = await prisma.user.findUnique({ where: { id: Number(req.params.id) } });
    if (!user) return res.status(404).json({ error: "User not found" });
    // Owners must not lock themselves out: deactivating your own account
    // would orphan the system with no admin login.
    if (Number(req.params.id) === req.user.sub && active === false) {
      return res.status(400).json({ error: "You cannot deactivate your own account" });
    }

    const data = {};
    if (active !== undefined) data.active = Boolean(active);
    if (name !== undefined && String(name).trim()) data.name = String(name).trim();
    if (username !== undefined) {
      const cleanUsername = String(username ?? "").trim();
      if (!cleanUsername) {
        return res.status(400).json({ error: "username cannot be empty" });
      }
      if (cleanUsername !== user.username) {
        const occupied = await prisma.user.findUnique({ where: { username: cleanUsername } });
        if (occupied && occupied.id !== user.id) {
          return res.status(409).json({ error: `Username "${cleanUsername}" already exists` });
        }
        data.username = cleanUsername;
      }
    }
    if (password !== undefined) {
      // The owner route is for resetting staff. Changing your OWN password
      // must go through Settings so the recovery-email OTP is required.
      if (Number(req.params.id) === req.user.sub) {
        return res.status(400).json({
          error: "Use Settings > Change password; your own change needs the email code",
        });
      }
      if (String(password).length < 6) {
        return res.status(400).json({ error: "password min 6 chars" });
      }
      if (Buffer.byteLength(String(password)) > 72) {
        return res.status(400).json({ error: "password must be 6-72 chars (bcrypt limit)" });
      }
      data.passwordHash = await bcrypt.hash(String(password), 10);
    }
    if (locationCode !== undefined) {
      if (locationCode === null || locationCode === "") {
        data.locationId = null;
      } else {
        const loc = await prisma.location.findUnique({ where: { code: String(locationCode) } });
        if (!loc) return res.status(404).json({ error: "Location not found" });
        data.locationId = loc.id;
      }
    }
    if (rfidUid !== undefined) {
      if (rfidUid === null || String(rfidUid).trim() === "") {
        data.rfidUid = null;
      } else {
        const cleanRfid = cleanRfidUid(rfidUid);
        if (!cleanRfid) {
          return res.status(400).json({
            error: "rfidUid must be 4-10 bytes of hex, e.g. 04A2B3C4",
          });
        }
        const taken = await prisma.user.findFirst({
          where: { rfidUid: cleanRfid, id: { not: user.id } },
        });
        if (taken) return res.status(409).json({ error: "RFID UID already registered" });
        data.rfidUid = cleanRfid;
      }
    }
    if (email !== undefined) {
      // Own email changes go through Settings, where the current password is
      // required. This route is for resetting OTHER staff.
      if (Number(req.params.id) === req.user.sub) {
        return res.status(400).json({
          error: "Use Settings > Recovery email; your own change needs your current password",
        });
      }
      if (email === null || String(email).trim() === "") {
        data.email = null;
      } else {
        const cleanEmail = normalizeEmail(email);
        if (!validEmail(cleanEmail)) {
          return res.status(400).json({ error: "email must be a valid email address" });
        }
        const taken = await prisma.user.findFirst({
          where: { email: cleanEmail, id: { not: user.id } },
        });
        if (taken) return res.status(409).json({ error: "Email already registered" });
        data.email = cleanEmail;
      }
    }

    const updated = await prisma.user.update({ where: { id: user.id }, data });
    if (data.passwordHash) {
      // An admin reset must end every existing session, otherwise a stolen
      // refresh token survives the reset.
      await prisma.refreshToken.deleteMany({ where: { userId: user.id } });
      await prisma.passwordReset.deleteMany({ where: { userId: user.id } });
    }
    if (data.email !== undefined) {
      // Codes sent to the old address must not survive a recovery-email swap.
      await prisma.passwordReset.deleteMany({ where: { userId: user.id } });
    }
    if (data.active === false) {
      // Disabled accounts lose API access via requireAuth, but their refresh
      // tokens must also die so no new access token can be minted.
      await prisma.refreshToken.deleteMany({ where: { userId: user.id } });
    }
    return res.json({ user: { id: updated.id, username: updated.username, name: updated.name, active: updated.active, rfidUid: updated.rfidUid, email: updated.email ?? null } });
  } catch (err) {
    return next(err);
  }
});

export default router;
