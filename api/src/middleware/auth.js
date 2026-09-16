import jwt from "jsonwebtoken";
import { db as prisma } from "../firestore.js";

const JWT_OPTS = { algorithms: ["HS256"] };

export async function requireAuth(req, res, next) {
  // Bearer header only. JWTs must never travel in query strings (server
  // logs, browser history, proxies); the SSE stream uses short-lived
  // tickets from POST /events/ticket instead (see routes/events.js).
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: "Missing bearer token" });
  }
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET, JWT_OPTS);
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
  // Access tokens only: a refresh token must never pass as API auth, even
  // when both secrets fall back to the same value. Legacy tokens without a
  // type claim are rejected (one-time re-login on cutover).
  if (!payload || payload.type !== "access" || payload.sub === undefined) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
  try {
    // Cached read (60s LRU): disabled accounts lose API access within ~a
    // minute instead of riding a 15m access token. Also enriches req.user
    // with locationId once so scoping checks cost zero extra reads.
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.active === false) {
      return res.status(401).json({ error: "Invalid or disabled account" });
    }
    req.user = { ...payload, locationId: user.locationId ?? null };
    return next();
  } catch (err) {
    return next(err);
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Forbidden: insufficient role" });
    }
    return next();
  };
}

/**
 * STAFF cart scoping for write endpoints. OWNERs bypass. Call inside the
 * handler AFTER the target location is resolved (so unknown carts still
 * 404 first). Throws a 403-tagged error suitable for in-transaction use;
 * outside transactions, prefer the boolean form via `ownsLocation`.
 */
export function assertOwnLocation(req, locationId) {
  if (req.user?.role === "OWNER") return;
  const own = req.user?.locationId;
  if (own === null || own === undefined) {
    throw Object.assign(new Error("Forbidden: no cart assigned to this account"), { status: 403 });
  }
  if (Number(locationId) !== Number(own)) {
    throw Object.assign(new Error("Forbidden: outside your assigned cart"), { status: 403 });
  }
}
