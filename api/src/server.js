import "dotenv/config";
import express from "express";
import cors from "cors";
import bonjour from "bonjour";
import rateLimit from "express-rate-limit";
import authRoutes from "./routes/auth.js";
import healthRouter from "./routes/health.js";
import catalogRoutes from "./routes/catalog.js";
import inventoryRoutes from "./routes/inventory.js";
import orderRoutes from "./routes/orders.js";
import alertRoutes from "./routes/alerts.js";
import reportRoutes from "./routes/reports.js";
import iotRoutes from "./routes/iot.js";
import analyticsRoutes from "./routes/analytics.js";
import expenseRoutes from "./routes/expenses.js";
import excelRoutes from "./routes/excel.js";
import deviceRoutes from "./routes/devices.js";
import locationRoutes from "./routes/locations.js";
import productRoutes from "./routes/products.js";
import eventRoutes from "./routes/events.js";
import { requireAuth } from "./middleware/auth.js";
import { errorHandler, notFound } from "./middleware/error.js";

const app = express();

// Trust proxy hops only when explicitly enabled (Render sets TRUST_PROXY=1;
// it terminates TLS at a proxy and needs real client IPs for rate limiting).
// Default 0: on direct LAN connections a client could otherwise spoof
// X-Forwarded-For to dodge the IP-based limiters below.
app.set("trust proxy", Number(process.env.TRUST_PROXY ?? 0));

// Fail fast when auth is misconfigured - otherwise every request 401s.
if (!process.env.JWT_SECRET) {
  console.error("[api:fatal] JWT_SECRET is not set. Add it to api/.env and restart.");
  process.exit(1);
}

// Browser origins: env-driven so LAN/DHCP changes don't need a code edit.
// CORS_ORIGINS="http://localhost:5173,http://192.168.100.217:5173"
const defaultOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://192.168.1.16:5173",
];
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
  : defaultOrigins;
app.use(cors({ origin: allowedOrigins }));

app.use(express.json({ limit: "1mb" }));

// Minimal security headers (no extra dep): deny framing, nosniff,
// minimal referrer. CSP is intentionally omitted — the API serves JSON,
// not HTML, and Hosting already sets its own policy for the web app.
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

// Abuse guards (in-memory, single-instance — same caveat as login limiter
// and SSE in README known limits). Generous caps so legit POS bursts pass.
const limitMsg = { error: "Too many requests - please slow down and retry" };
const refreshLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, message: limitMsg });
const ordersLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, message: limitMsg });
const importLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, message: limitMsg });
const locationsLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, message: limitMsg });
const iotLimiter = rateLimit({ windowMs: 60 * 1000, max: 300, message: limitMsg });
const ticketLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, message: limitMsg });
const exportLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 30, message: limitMsg });
const analyticsLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, message: limitMsg });
const passwordLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: limitMsg });
const expensesLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, message: limitMsg });
app.use("/api/auth/refresh", refreshLimiter);
app.use("/api/auth/logout", refreshLimiter);
app.use("/api/orders", ordersLimiter);
app.use("/api/import", importLimiter);
app.use("/api/locations", locationsLimiter);
app.use("/api/iot", iotLimiter);
app.use("/api/shifts", iotLimiter);
app.use("/api/events/ticket", ticketLimiter);
app.use("/api/export", exportLimiter);
app.use("/api/analytics", analyticsLimiter);
app.use("/api/reorders", analyticsLimiter);
app.use("/api/auth/change-password", passwordLimiter);
app.use("/api/expenses", expensesLimiter);

app.use("/api/auth", authRoutes);
app.use("/api", catalogRoutes);
app.use("/api", inventoryRoutes);
app.use("/api", orderRoutes);
app.use("/api", alertRoutes);
app.use("/api", reportRoutes);
app.use("/api", iotRoutes);
app.use("/api", analyticsRoutes);
app.use("/api", expenseRoutes);
app.use("/api", excelRoutes);
app.use("/api", deviceRoutes);
app.use("/api", locationRoutes);
app.use("/api", productRoutes);
// SSE must be registered so its handler is added to the broadcaster.
app.use("/api", eventRoutes);
app.use("/api", healthRouter);

app.use(notFound);
app.use(errorHandler);

// Default stays localhost-only for safety. Set HOST=0.0.0.0 in .env when a
// physical phone on the same Wi-Fi needs to reach the API.
const HOST = process.env.HOST || "127.0.0.1";
const PORT = process.env.PORT || 4000;

const server = app.listen(PORT, HOST, () => {
  console.log(`CartIQ API listening on http://${HOST}:${PORT}${HOST === "127.0.0.1" ? " (localhost only)" : " (LAN-exposed)"}`);
  
  // Advertise the API via mDNS (Bonjour) so mobile clients can discover it
  // automatically without hardcoding IP addresses. Skipped when
  // DISABLE_MDNS=true (cloud hosts like Render have no mDNS); the try/catch
  // keeps a multicast failure from ever taking the API down.
  if (HOST !== "127.0.0.1" && process.env.DISABLE_MDNS !== "true") {
    try {
      const mdns = bonjour();
    const service = mdns.publish({
      name: "CartIQ API",
      type: "http",
      port: PORT,
      txt: { id: "cartiq-api" }
    });
    
    service.on("up", () => console.log("mDNS service advertised: CartIQ API"));
    service.on("error", err => console.error("mDNS error:", err));
    
    // Clean up on shutdown
    const shutdown = () => {
      service.stop();
      mdns.destroy();
      console.log("mDNS service stopped");
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    } catch (err) {
      console.error("mDNS unavailable, continuing without advertisement:", err.message);
    }
  }
});
