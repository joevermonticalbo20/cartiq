import bcrypt from "bcryptjs";
import { db as prisma } from "../firestore.js";

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
    // A row without a stored hash can never match; skip instead of letting
    // bcrypt throw a 500.
    if (!device.tokenHash) continue;
    let match = false;
    try {
      match = await bcrypt.compare(token, device.tokenHash);
    } catch {
      continue; // malformed hash — treat as non-match, not a crash
    }
    if (match) {
      // A provisioned device without a cart assignment has no location
      // context for readings/shifts — fail loudly (403) instead of
      // crashing later on req.device.location.code (500).
      if (!device.location) {
        return res.status(403).json({ error: "Device has no assigned cart" });
      }
      req.device = device;
      prisma.device
        .update({ where: { id: device.id }, data: { lastSeenAt: new Date() } })
        .catch(() => {});
      return next();
    }
  }
  return res.status(401).json({ error: "Unknown or inactive device" });
}
