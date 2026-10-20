import { Router } from "express";
import { db as prisma } from "../firestore.js";
import { requireAuth } from "../middleware/auth.js";
import { recipeAvailability } from "../services/inventory_rules.js";

const router = Router();

router.get("/catalog", requireAuth, async (req, res, next) => {
  try {
    // POS bootstrap: always fresh (nocache). A stale catalog would sell
    // removed products or wrong prices — correctness beats quota here, and
    // catalog loads are infrequent (screen open / pull-to-refresh).
    // Archived products (active === false) are hidden from the POS but stay
    // in history/reports. Pre-archive docs have no field and count as active.
    const [all, locations, maps] = await Promise.all([
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
      prisma.ingredientMap.findMany({ nocache: true }),
    ]);
    const locationId = req.user?.locationId ?? locations[0]?.id;
    const inventory = locationId == null
      ? []
      : await prisma.inventoryItem.findMany({
          where: { locationId },
          nocache: true,
        });
    const inventoryByName = new Map(inventory.map((item) => [item.name, item]));
    const products = all.filter((p) => p.active !== false);
    const catalog = products.map((product) => {
      const flavors = (product.flavors ?? []).map((flavor) => ({
        ...flavor,
        ...recipeAvailability(product.name, flavor.name, maps, inventoryByName),
      }));
      const options = flavors.length
        ? flavors
        : [recipeAvailability(product.name, "", maps, inventoryByName)];
      const bestOption = options.reduce((best, option) =>
        option.availableServings > best.availableServings ? option : best,
      );
      return {
        ...product,
        flavors,
        isAvailable: options.some((option) => option.isAvailable),
        availableServings: bestOption.availableServings,
        limitingIngredient: bestOption.limitingIngredient,
      };
    });
    return res.json({ products: catalog, locations });
  } catch (err) {
    return next(err);
  }
});

export default router;
