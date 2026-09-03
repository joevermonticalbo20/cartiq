import { Router } from "express";
import { prisma } from "../prisma.js";

const healthRouter = Router();

const startedAt = Date.now();

healthRouter.get("/health", async (_req, res) => {
  let db = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    db = true;
  } catch {
    db = false;
  }
  const body = {
    ok: db,
    service: "cartiq-api",
    version: process.env.npm_package_version ?? "0.1.0",
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    db,
    time: new Date().toISOString(),
  };
  res.status(db ? 200 : 503).json(body);
});

export default healthRouter;
