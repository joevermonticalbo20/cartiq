import { Router } from "express";
import { db as prisma, readCatalogVersion } from "../firestore.js";
import { requireAuth } from "../middleware/auth.js";
import { recipeAvailability } from "../services/inventory_rules.js";
import { sortFlavorRows } from "../services/flavor_order.js";
import { servedImageUrl, uploadedImageTimes } from "../services/product_images.js";

const router = Router();

// GET /api/catalog/version — one-document probe the POS app polls to notice
// dashboard menu changes without refetching the whole catalog every minute.
// Mounted BEFORE /catalog so "version" is never read as a product filter.
router.get("/catalog/version", requireAuth, async (_req, res, next) => {
  try {
    return res.json({ version: await readCatalogVersion() });
  } catch (err) {
    return next(err);
  }
});

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
    const uploadTimes = await uploadedImageTimes();
    const inventoryByName = new Map(inventory.map((item) => [item.name, item]));
    const products = all.filter((p) => p.active !== false);
    const catalog = products.map((product) => {
      // Per-flavor absolute price (POS size/price options): the Products UI
      // stores overrides in flavorPrices; missing names fall back to the
      // product base price, exactly like the management list.
      const flavorPrices = product.flavorPrices ?? {};
      // Size-aware order (Medium, Large, XL 40, XL 50) so the POS picker
      // lists sizes the way the menu is spoken.
      const flavors = sortFlavorRows(product.flavors ?? []).map((flavor) => ({
        ...flavor,
        unitPrice: Number(flavorPrices[flavor.name] ?? product.basePrice),
        hasCustomPrice: flavorPrices[flavor.name] !== undefined,
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
        // Uploaded photo (public endpoint) wins over any pasted URL.
        imageUrl: servedImageUrl(req, product, uploadTimes),
        flavors,
        isAvailable: options.some((option) => option.isAvailable),
        availableServings: bestOption.availableServings,
        limitingIngredient: bestOption.limitingIngredient,
      };
    });
    // The app remembers this and only refetches when the probe reports a
    // different value.
    const version = await readCatalogVersion();
    return res.json({ products: catalog, locations, version });
  } catch (err) {
    return next(err);
  }
});

export default router;
