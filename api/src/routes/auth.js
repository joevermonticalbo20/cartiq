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
  OTP_TTL_MS,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_MS,
  FORGOT_GENERIC_MESSAGE,
  RESET_INVALID_MESSAGE,
} from "../services/password_reset.js";
import { sendGmail, resetEmailContent, gmailStatus } from "../services/gmail.js";

// Rate limiter: 20 attempts per 15 min per IP. High enough that the
// project's own regression suite (~10 logins back-to-back from one dev
// machine) and typo-prone staff logins don't trip it, low enough that
// password guessing stays impractical (~80/hr/IP).
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: "Too many login attempts - please try again in 15 minutes" },
});

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

const router = Router();

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    role: user.role,
    email: user.email ?? null,
    location: user.location
      ? { id: user.location.id, code: user.location.code, name: user.location.name }
      : null,
  };
}

router.post("/login", loginLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body ?? {};
    if (!username || !password) {
      return res.status(400).json({ error: "username and password are required" });
    }
    // Usernames are matched trimmed (the POS keyboard may add spaces).
    const cleanUsername = String(username).trim();
    const user = await prisma.user.findUnique({
      where: { username: cleanUsername },
      include: { location: true },
    });
    // One message for every failure: distinct "disabled account" vs
    // "bad password" responses let attackers enumerate accounts.
    if (!user || user.active === false) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    if (!(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
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
      const fresh = unused[0];
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
            tokenHash: hashOtp(code),
            expiresAt: new Date(Date.now() + OTP_TTL_MS),
          },
        });
        try {
          const { subject, text } = resetEmailContent(code);
          await sendGmail({ to: email, subject, text });
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
      .filter((r) => !r.used)
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
      .filter((r) => !r.used)
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

// GET /auth/gmail-status (OWNER) - diagnostics for the Gmail OTP sender.
// Reports presence booleans + a live token-exchange check, never secret
// values. Use this first when reset emails don't arrive.
router.get("/gmail-status", requireAuth, requireRole("OWNER"), async (_req, res, next) => {
  try {
    return res.json(await gmailStatus());
  } catch (err) {
    return next(err);
  }
});

router.post("/change-password", requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body ?? {};
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
    const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
    if (!user) return res.status(404).json({ error: "User not found" });
    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await bcrypt.hash(newPassword, 10) },
    });
    // Revoke every session: a stolen refresh token must die with the old
    // password. Note the current access JWT stays valid up to 15m; clients
    // should drop local tokens and re-login immediately after this call.
    await prisma.refreshToken.deleteMany({ where: { userId: user.id } });
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
    const { name, username, password, locationCode, rfidUid, email } = req.body ?? {};
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
    if (locationCode) {
      const loc = await prisma.location.findUnique({ where: { code: String(locationCode) } });
      if (!loc) return res.status(404).json({ error: "Location not found" });
      locationId = loc.id;
    }
    if (rfidUid) {
      const uidTaken = await prisma.user.findUnique({ where: { rfidUid } });
      if (uidTaken) return res.status(409).json({ error: "RFID UID already registered" });
    }

    const user = await prisma.user.create({
      data: {
        name,
        username: cleanUsername,
        passwordHash: await bcrypt.hash(String(password), 10),
        role: "STAFF",
        active: true,
        locationId,
        rfidUid: rfidUid ?? null,
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
    const { active, password, name, locationCode, rfidUid, email } = req.body ?? {};
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
    if (password !== undefined) {
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
      if (rfidUid === null || rfidUid === "") {
        data.rfidUid = null;
      } else {
        const taken = await prisma.user.findFirst({
          where: { rfidUid, id: { not: user.id } },
        });
        if (taken) return res.status(409).json({ error: "RFID UID already registered" });
        data.rfidUid = rfidUid;
      }
    }
    if (email !== undefined) {
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
