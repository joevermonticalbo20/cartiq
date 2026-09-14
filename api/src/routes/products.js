import { Router } from "express";
import { db as prisma } from "../firestore.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();

function countLetters(s) {
  const m = String(s ?? "").match(/\p{L}/gu);
  return m ? m.length : 0;
}

function validProductName(name) {
  const n = String(name ?? "").trim();
  return n.length >= 2 && n.length <= 120 && countLetters(n) >= 2;
}

async function flavorByIdOr404(ids) {
  const flavors = await prisma.flavor.findMany();
  const byId = new Map(flavors.map((f) => [f.id, f]));
  for (const id of ids ?? []) {
    if (!byId.has(Number(id))) return null;
  }
  return byId;
}

// GET /api/products (any auth) — catalog management view: flavors, recipe
// usage, and order-reference counts so the UI can explain delete blocks.
router.get("/products", requireAuth, async (_req, res, next) => {
  try {
    const [products, maps, orders] = await Promise.all([
      prisma.product.findMany({
        include: { flavors: { orderBy: { name: "asc" } } },
        orderBy: { name: "asc" },
      }),
      prisma.ingredientMap.findMany(),
      prisma.order.findMany({ select: { items: true } }),
    ]);
    const recipeCount = new Map();
    for (const m of maps) {
      recipeCount.set(m.productName, (recipeCount.get(m.productName) ?? 0) + 1);
    }
    const orderRefs = new Map();
    for (const o of orders) {
      for (const it of o.items ?? []) {
        orderRefs.set(it.productName, (orderRefs.get(it.productName) ?? 0) + it.qty);
      }
    }
    return res.json({
      data: products.map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        basePrice: p.basePrice,
        flavors: p.flavors,
        recipeCount: recipeCount.get(p.name) ?? 0,
        orderLines: orderRefs.get(p.name) ?? 0,
      })),
    });
  } catch (err) {
    return next(err);
  }
});

// POST /api/products (OWNER) — add a catalog product.
// Body: { name*, category?, basePrice*, flavorIds?[] }
router.post("/products", requireAuth, requireRole("OWNER"), async (req, res, next) => {
  try {
    const { name, category, basePrice, flavorIds } = req.body ?? {};
    if (!validProductName(name)) {
      return res.status(400).json({ error: "name needs at least 2 letters (max 120 characters)" });
    }
    const price = Number(basePrice);
    if (!Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ error: "basePrice must be a positive number" });
    }
    const ids = Array.isArray(flavorIds) ? [...new Set(flavorIds.map(Number))] : [];
    if (!(await flavorByIdOr404(ids))) {
      return res.status(404).json({ error: "One or more flavors not found" });
    }
    const productName = String(name).trim();
    const clash = await prisma.product.findMany();
    if (clash.some((p) => p.name.toLowerCase() === productName.toLowerCase())) {
      return res.status(409).json({ error: `Product "${productName}" already exists` });
    }
    const product = await prisma.product.create({
      data: {
        name: productName,
        category: category ? String(category).slice(0, 60) : undefined,
        basePrice: price,
        ...(ids.length ? { flavorIds: ids } : {}),
      },
      include: { flavors: true },
    });
    return res.status(201).json({ product });
  } catch (err) {
    if (err.code === "P2002") return res.status(409).json({ error: "Product already exists" });
    return next(err);
  }
});

// PATCH /api/products/:id (OWNER) — category/price/flavor links.
// Price applies to future sales only; history keeps its recorded totals.
// Body: { category?, basePrice?, addFlavorIds?[], removeFlavorIds?[] }
router.patch("/products/:id", requireAuth, requireRole("OWNER"), async (req, res, next) => {
  try {
    const { category, basePrice, addFlavorIds, removeFlavorIds } = req.body ?? {};
    if (
      category === undefined &&
      basePrice === undefined &&
      addFlavorIds === undefined &&
      removeFlavorIds === undefined
    ) {
      return res.status(400).json({ error: "provide category, basePrice, addFlavorIds, or removeFlavorIds" });
    }
    const existing = await prisma.product.findUnique({
      where: { id: Number(req.params.id) },
      include: { flavors: true },
    });
    if (!existing) return res.status(404).json({ error: "Product not found" });
    const data = {};
    if (category !== undefined) data.category = String(category).slice(0, 60) || "Fries";
    if (basePrice !== undefined) {
      const price = Number(basePrice);
      if (!Number.isFinite(price) || price <= 0) {
        return res.status(400).json({ error: "basePrice must be a positive number" });
      }
      data.basePrice = price;
    }
    const current = new Set(existing.flavorIds ?? existing.flavors.map((f) => f.id));
    if (addFlavorIds !== undefined || removeFlavorIds !== undefined) {
      const adds = Array.isArray(addFlavorIds) ? addFlavorIds.map(Number) : [];
      const removes = new Set(
        Array.isArray(removeFlavorIds) ? removeFlavorIds.map(Number) : []
      );
      if (!(await flavorByIdOr404(adds))) {
        return res.status(404).json({ error: "One or more flavors not found" });
      }
      for (const id of adds) current.add(id);
      for (const id of removes) current.delete(id);
      data.flavorIds = [...current];
    }
    const product = await prisma.product.update({
      where: { id: existing.id },
      data,
      include: { flavors: { orderBy: { name: "asc" } } },
    });
    return res.json({ product });
  } catch (err) {
    return next(err);
  }
});

// PATCH /api/products/:id/rename (OWNER) — explicit rename that also rewrites
// recipe rows (keyed by product name) in one transaction. Past orders keep
// the old name (historical truth).
// Body: { name* }
router.patch("/products/:id/rename", requireAuth, requireRole("OWNER"), async (req, res, next) => {
  try {
    const { name } = req.body ?? {};
    if (!validProductName(name)) {
      return res.status(400).json({ error: "name needs at least 2 letters (max 120 characters)" });
    }
    const existing = await prisma.product.findUnique({ where: { id: Number(req.params.id) } });
    if (!existing) return res.status(404).json({ error: "Product not found" });
    const nextName = String(name).trim();
    if (nextName.toLowerCase() === existing.name.toLowerCase()) {
      return res.status(400).json({ error: "New name is the same as the current name" });
    }
    const clash = await prisma.product.findMany();
    if (clash.some((p) => p.id !== existing.id && p.name.toLowerCase() === nextName.toLowerCase())) {
      return res.status(409).json({ error: `Product "${nextName}" already exists` });
    }
    const outcome = await prisma.runTransaction(async (tx) => {
      const maps = await tx.ingredientMap.findMany({ where: { productName: existing.name } });
      const updated = await tx.product.update({
        where: { id: existing.id },
        data: { name: nextName },
        include: { flavors: true },
      });
      // ingredientMaps carry auto-ID docs; rewrite inside the same transaction
      // via the raw txn handle so rename + recipe rewrite stay atomic.
      for (const m of maps) {
        tx.txn.update(tx._firestore.collection("ingredientMaps").doc(String(m.id)), {
          productName: nextName,
        });
      }
      return { updated, mapsUpdated: maps.length };
    });
    return res.json({ product: outcome.updated, mapsUpdated: outcome.mapsUpdated });
  } catch (err) {
    return next(err);
  }
});

// DELETE /api/products/:id (OWNER) — blocked while order lines or recipes
// reference the name; otherwise removes the product (+ its recipe rows).
router.delete("/products/:id", requireAuth, requireRole("OWNER"), async (req, res, next) => {
  try {
    const existing = await prisma.product.findUnique({ where: { id: Number(req.params.id) } });
    if (!existing) return res.status(404).json({ error: "Product not found" });
    const [maps, orders] = await Promise.all([
      prisma.ingredientMap.findMany({ where: { productName: existing.name } }),
      prisma.order.findMany({ select: { items: true } }),
    ]);
    const usedInOrders = orders.reduce(
      (n, o) => n + (o.items ?? []).filter((it) => it.productName === existing.name).length,
      0
    );
    if (usedInOrders > 0 || maps.length > 0) {
      return res.status(409).json({
        error: `Cannot delete "${existing.name}": referenced by ${usedInOrders} order line(s) and ${maps.length} recipe row(s)`,
        orderLines: usedInOrders,
        recipeRows: maps.length,
      });
    }
    await prisma.product.delete({ where: { id: existing.id } });
    return res.json({ deleted: true });
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "Product not found" });
    return next(err);
  }
});

// GET /api/flavors (any auth) — global flavor list for pickers.
router.get("/flavors", requireAuth, async (_req, res, next) => {
  try {
    const flavors = await prisma.flavor.findMany({ orderBy: { name: "asc" } });
    return res.json({ data: flavors });
  } catch (err) {
    return next(err);
  }
});

// POST /api/flavors (OWNER) — create a global flavor for linking.
// Body: { name* }
router.post("/flavors", requireAuth, requireRole("OWNER"), async (req, res, next) => {
  try {
    const flavorName = String(req.body?.name ?? "").trim();
    if (flavorName.length < 1 || flavorName.length > 60) {
      return res.status(400).json({ error: "name must be 1-60 characters" });
    }
    const existing = await prisma.flavor.findMany();
    if (existing.some((f) => f.name.toLowerCase() === flavorName.toLowerCase())) {
      return res.status(409).json({ error: `Flavor "${flavorName}" already exists` });
    }
    const flavor = await prisma.flavor.create({ data: { name: flavorName } });
    return res.status(201).json({ flavor });
  } catch (err) {
    if (err.code === "P2002") return res.status(409).json({ error: "Flavor already exists" });
    return next(err);
  }
});

export default router;
