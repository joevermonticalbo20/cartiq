import bcrypt from "bcryptjs";
import { prisma } from "../prisma.js";

// Device (ESP32 node) authentication. Tokens are bcrypt-hashed at rest;
// with only a handful of active nodes, comparing each is fine.
export async function requireDevice(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: "Missing device token" });
  }
  const devices = await prisma.device.findMany({
    where: { active: true },
    include: { location: true },
  });
  for (const device of devices) {
    if (await bcrypt.compare(token, device.tokenHash)) {
      req.device = device;
      prisma.device
        .update({ where: { id: device.id }, data: { lastSeenAt: new Date() } })
        .catch(() => {});
      return next();
    }
  }
  return res.status(401).json({ error: "Unknown or inactive device" });
}
