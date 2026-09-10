import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import { prisma } from "../prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

// Rate limiter: 20 attempts per 15 min per IP. High enough that the
// project's own regression suite (~10 logins back-to-back from one dev
// machine) and typo-prone staff logins don't trip it, low enough that
// password guessing stays impractical (~80/hr/IP).
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: "Too many login attempts - please try again in 15 minutes" },
});

const router = Router();

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    role: user.role,
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
    const user = await prisma.user.findUnique({
      where: { username },
      include: { location: true },
    });
    if (!user || user.active === false) {
      return res.status(401).json({ error: "Invalid credentials or disabled account" });
    }
    if (!(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const accessToken = jwt.sign(
      { sub: user.id, username: user.username, role: user.role, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: "12h" }
    );
    const refreshToken = jwt.sign(
      // jti guarantees uniqueness: without it, two logins in the same
      // second produce byte-identical JWTs and collide on token UNIQUE.
      { sub: user.id, username: user.username, role: user.role, name: user.name, jti: crypto.randomUUID() },
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
        process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET
      );
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
    // Rotate token: revoke old one, issue new one
    await prisma.refreshToken.delete({ where: { id: tokenRecord.id } });

    const user = await prisma.user.findUnique({
      where: { id: tokenRecord.userId },
      include: { location: true },
    });
    if (!user) return res.status(404).json({ error: "User not found" });

    const newAccessToken = jwt.sign(
      { sub: user.id, username: user.username, role: user.role, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: "12h" }
    );
    const newRefreshToken = jwt.sign(
      // jti: see login route - same-second rotations must not collide.
      { sub: user.id, username: user.username, role: user.role, name: user.name, jti: crypto.randomUUID() },
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

router.post("/change-password", requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body ?? {};
    if (!currentPassword || !newPassword || String(newPassword).length < 6) {
      return res.status(400).json({ error: "currentPassword and newPassword (min 6 chars) are required" });
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
    return res.json({ updated: true });
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
    const { name, username, password, locationCode, rfidUid } = req.body ?? {};
    if (!name || !username || !password || String(password).length < 6) {
      return res.status(400).json({ error: "name, username and password (min 6 chars) required" });
    }
    const exists = await prisma.user.findUnique({ where: { username } });
    if (exists) return res.status(409).json({ error: `Username "${username}" already exists` });

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
        username,
        passwordHash: await bcrypt.hash(String(password), 10),
        role: "STAFF",
        active: true,
        locationId,
        rfidUid: rfidUid ?? null,
      },
    });
    return res.status(201).json({ user: { id: user.id, username: user.username, name: user.name, role: user.role, active: user.active } });
  } catch (err) {
    return next(err);
  }
});

router.patch("/staff/:id", requireAuth, requireRole("OWNER"), async (req, res, next) => {
  try {
    const { active, password, name, locationCode, rfidUid } = req.body ?? {};
    const user = await prisma.user.findUnique({ where: { id: Number(req.params.id) } });
    if (!user) return res.status(404).json({ error: "User not found" });

    const data = {};
    if (active !== undefined) data.active = Boolean(active);
    if (name !== undefined && String(name).trim()) data.name = String(name).trim();
    if (password !== undefined) {
      if (String(password).length < 6) {
        return res.status(400).json({ error: "password min 6 chars" });
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

    const updated = await prisma.user.update({ where: { id: user.id }, data });
    return res.json({ user: { id: updated.id, username: updated.username, name: updated.name, active: updated.active, rfidUid: updated.rfidUid } });
  } catch (err) {
    return next(err);
  }
});

export default router;
