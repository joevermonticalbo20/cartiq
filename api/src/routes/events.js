import { randomBytes } from "node:crypto";
import { Router } from "express";
import { prisma } from "../prisma.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

const _clients = new Set();

// Short-lived stream tickets: EventSource cannot send an Authorization
// header, so clients trade their Bearer JWT (over a header-authenticated
// POST) for a 60-second ticket used only as ?ticket=. A leaked ticket
// expires in a minute and reveals no session; the JWT never hits a URL.
const TICKET_TTL_MS = 60 * 1000;
const MAX_TICKETS = 1000;
const _tickets = new Map(); // ticket -> { userId, exp }

function pruneTickets(now = Date.now()) {
  for (const [ticket, rec] of _tickets) {
    if (rec.exp <= now) _tickets.delete(ticket);
  }
  // Hard backstop against unbounded growth.
  if (_tickets.size > MAX_TICKETS) _tickets.clear();
}

// POST /api/events/ticket (Bearer JWT) -> { ticket, expiresAt }
router.post("/events/ticket", requireAuth, (req, res) => {
  pruneTickets();
  const ticket = randomBytes(32).toString("hex");
  _tickets.set(ticket, { userId: req.user.sub, exp: Date.now() + TICKET_TTL_MS });
  return res.json({ ticket, expiresAt: new Date(Date.now() + TICKET_TTL_MS).toISOString() });
});

// Ticket auth for the stream only. Reconnects reuse the URL while the
// ticket is alive; useSSE fetches a fresh one on every (re)connect.
function sseAuth(req, res, next) {
  const ticket = req.query.ticket;
  if (typeof ticket === "string" && ticket) {
    const rec = _tickets.get(ticket);
    if (rec && rec.exp > Date.now()) {
      req.user = { sub: rec.userId };
      return next();
    }
    return res.status(401).json({ error: "Invalid or expired stream ticket" });
  }
  return requireAuth(req, res, next);
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const send of _clients) {
    try { send(payload); } catch { _clients.delete(send); }
  }
}

export function emit(event, data) {
  if (_clients.size === 0) return;
  broadcast(event, { ...data, _time: new Date().toISOString() });
}

// GET /api/events?ticket=<stream-ticket> (SSE - EventSource can't set
// headers, so it uses a 60s ticket from POST /events/ticket; the JWT
// itself never appears in a URL).
router.get("/events", sseAuth, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (raw) => res.write(raw);
  send(`event: connected\ndata: ${JSON.stringify({ time: new Date().toISOString() })}\n\n`);

  const heartbeat = setInterval(() => {
    if (res.writableEnded) { clearInterval(heartbeat); _clients.delete(send); return; }
    res.write(": heartbeat\n\n");
  }, 25000);

  _clients.add(send);
  req.on("close", () => { clearInterval(heartbeat); _clients.delete(send); });
});

export default router;
