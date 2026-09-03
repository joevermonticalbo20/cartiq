import { Router } from "express";
import { prisma } from "../prisma.js";

const healthRouter = Router();

healthRouter.get("/health", async (_req, res) => {
  let db = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    db = true;
  } catch {
    db = false;
  }
  res.json({
    ok: true,
    service: "cartiq-api",
    db,
    time: new Date().toISOString(),
  });
});

export default healthRouter;
