import { Router } from "express";
import { prisma } from "../prisma.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

const _clients = new Set();

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

// GET /api/events?token=<jwt>  (SSE — token via query so EventSource can use it)
router.get("/events", requireAuth, (req, res) => {
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
