import jwt from "jsonwebtoken";

export function requireAuth(req, res, next) {
  // Bearer header only. JWTs must never travel in query strings (server
  // logs, browser history, proxies); the SSE stream uses short-lived
  // tickets from POST /events/ticket instead (see routes/events.js).
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: "Missing bearer token" });
  }
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
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
