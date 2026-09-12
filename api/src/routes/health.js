import { Router } from "express";
import { db as prisma } from "../firestore.js";

const healthRouter = Router();
const startedAt = Date.now();

healthRouter.get("/health", async (_req, res) => {
  let db = false;
  try {
    await prisma.ping();
    db = true;
  } catch {
    db = false;
  }
  const envCheck = !!process.env.JWT_SECRET;
  const body = {
    ok: db && envCheck,
    service: "cartiq-api",
    version: process.env.npm_package_version ?? "0.1.0",
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    checks: {
      db: { status: db ? "ok" : "fail" },
      env: { status: envCheck ? "ok" : "fail", detail: envCheck ? "JWT_SECRET present" : "JWT_SECRET missing" },
    },
    time: new Date().toISOString(),
  };
  res.status(body.ok ? 200 : 503).json(body);
});

export default healthRouter;
