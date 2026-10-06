import { Router } from "express";
import { db as prisma } from "../firestore.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.get("/catalog", requireAuth, async (_req, res, next) => {
  try {
    // POS bootstrap: always fresh (nocache). A stale catalog would sell
    // removed products or wrong prices — correctness beats quota here, and
    // catalog loads are infrequent (screen open / pull-to-refresh).
    // Archived products (active === false) are hidden from the POS but stay
    // in history/reports. Pre-archive docs have no field and count as active.
    const [all, locations] = await Promise.all([
      prisma.product.findMany({
        include: { flavors: { orderBy: { name: "asc" } } },
        orderBy: { name: "asc" },
        nocache: true,
      }),
      prisma.location.findMany({
        where: { status: "ACTIVE" },
        select: { id: true, code: true, name: true },
        orderBy: { code: "asc" },
        nocache: true,
      }),
    ]);
    const products = all.filter((p) => p.active !== false);
    return res.json({ products, locations });
  } catch (err) {
    return next(err);
  }
});

export default router;
