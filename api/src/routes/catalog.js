import { Router } from "express";
import { prisma } from "../prisma.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.get("/catalog", requireAuth, async (_req, res, next) => {
  try {
    const [products, locations] = await Promise.all([
      prisma.product.findMany({
        include: { flavors: { orderBy: { name: "asc" } } },
        orderBy: { name: "asc" },
      }),
      prisma.location.findMany({
        where: { status: "ACTIVE" },
        select: { id: true, code: true, name: true },
        orderBy: { code: "asc" },
      }),
    ]);
    return res.json({ products, locations });
  } catch (err) {
    return next(err);
  }
});

export default router;
