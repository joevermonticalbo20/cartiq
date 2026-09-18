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

function validPrice(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Resolve `flavors[]` entries (per-flavor rows from the Products UI) into
// flavor ids. Each entry may be a numeric id, a bare name string, or
// { flavorId?, name?, unitPrice?, recipes?[] }. Unknown names are
// auto-created (same as the Excel import) so Add-product never stalls on a
// missing flavor. Returns { ids, byId, idByName, created } or { error }.
async function resolveFlavorEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length > 20) return { error: "at most 20 flavors per product" };
  const flavors = await prisma.flavor.findMany();
  const byId = new Map(flavors.map((f) => [Number(f.id), f]));
  const byName = new Map(flavors.map((f) => [String(f.name).toLowerCase(), f]));
  const idByName = new Map(flavors.map((f) => [String(f.name).toLowerCase(), Number(f.id)]));
  const ids = [];
  const seen = new Set();
  const created = [];
  for (const e of list) {
    let id = null;
    const asObj = e !== null && typeof e === "object" ? e : null;
    const rawId = asObj ? (asObj.flavorId ?? asObj.id) : e;
    if (typeof rawId === "number" || (typeof rawId === "string" && /^\d+$/.test(rawId.trim()))) {
      id = Number(rawId);
      if (!byId.has(id)) return { error: "One or more flavors not found" };
    } else {
      const name = String(asObj ? (asObj.name ?? "") : (e ?? "")).trim();
      if (!name || name.length > 60) {
        return { error: "flavor name must be 1-60 characters" };
      }
      const hit = byName.get(name.toLowerCase());
      if (hit) {
        id = Number(hit.id);
      } else {
        const f = await prisma.flavor.create({ data: { name } });
        byId.set(Number(f.id), f);
        byName.set(name.toLowerCase(), f);
        idByName.set(name.toLowerCase(), Number(f.id));
        created.push(f);
        id = Number(f.id);
      }
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return { ids, byId, idByName, created };
}

// Validate one recipe row { itemName, amountPerUnit }. Returns the cleaned
// row or null.
function validRecipeRow(r) {
  const itemName = String(r?.itemName ?? "").trim();
  const amount = Number(r?.amountPerUnit);
  if (!itemName || itemName.length > 120) return null;
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { itemName, amountPerUnit: amount };
}

// Upsert recipe rows for one (productName, flavorName) pair. Same-triple
// rows update their amount; new triples are created. Returns count created.
async function upsertRecipeRows(productName, flavorName, rows) {
  let created = 0;
  for (const r of rows ?? []) {
    const row = validRecipeRow(r);
    if (!row) return { error: `recipe rows need itemName (1-120 chars) and amountPerUnit > 0` };
    const existing = await prisma.ingredientMap.findMany({
      where: { productName, flavor: flavorName, itemName: row.itemName },
    });
    if (existing.length > 0) {
      await prisma.ingredientMap.updateMany({
        where: { productName, flavor: flavorName, itemName: row.itemName },
        data: { amountPerUnit: row.amountPerUnit },
      });
    } else {
      await prisma.ingredientMap.create({
        data: { productName, flavor: flavorName, itemName: row.itemName, amountPerUnit: row.amountPerUnit },
      });
      created += 1;
    }
  }
  return { created };
}

// GET /api/products (any auth) — catalog management view: flavors, recipe
// usage, and order-reference counts so the UI can explain delete blocks.
router.get("/products", requireAuth, async (_req, res, next) => {
  try {
    const [products, maps, orders, invRows] = await Promise.all([
      prisma.product.findMany({
        include: { flavors: { orderBy: { name: "asc" } } },
        orderBy: { name: "asc" },
      }),
      prisma.ingredientMap.findMany(),
      prisma.order.findMany({ select: { items: true } }),
      prisma.inventoryItem.findMany({ select: { name: true } }),
    ]);
    // Deduction matches map.itemName to inventory rows by EXACT name, so
    // surface coverage: recipe items with no stock row anywhere can never
    // deduct (the sale warns instead). missingItems names them per flavor.
    const knownItems = new Set(invRows.map((r) => String(r.name ?? "").trim()).filter(Boolean));
    const recipeCount = new Map();
    const recipeByFlavor = new Map();
    const itemsByFlavor = new Map();
    const rowsByFlavor = new Map();
    const flavorKey = (productName, flavor) => JSON.stringify([productName, flavor ?? ""]);
    for (const m of maps) {
      recipeCount.set(m.productName, (recipeCount.get(m.productName) ?? 0) + 1);
      const key = flavorKey(m.productName, m.flavor);
      recipeByFlavor.set(key, (recipeByFlavor.get(key) ?? 0) + 1);
      if (!itemsByFlavor.has(key)) itemsByFlavor.set(key, []);
      itemsByFlavor.get(key).push(m.itemName);
      if (!rowsByFlavor.has(key)) rowsByFlavor.set(key, []);
      rowsByFlavor.get(key).push({ itemName: m.itemName, amountPerUnit: m.amountPerUnit });
    }
    const orderRefs = new Map();
    for (const o of orders) {
      for (const it of o.items ?? []) {
        orderRefs.set(it.productName, (orderRefs.get(it.productName) ?? 0) + it.qty);
      }
    }
    return res.json({
      data: products.map((p) => {
        const flavorPrices = p.flavorPrices ?? {};
        return {
          id: p.id,
          name: p.name,
          category: p.category,
          basePrice: p.basePrice,
          flavorPrices,
          flavors: (p.flavors ?? []).map((f) => ({
            id: f.id,
            name: f.name,
            // Absolute per-flavor price; falls back to the product base price
            // when no override was saved for this flavor.
            unitPrice: Number(flavorPrices[f.name] ?? p.basePrice),
            hasCustomPrice: flavorPrices[f.name] !== undefined,
            recipeCount: recipeByFlavor.get(flavorKey(p.name, f.name)) ?? 0,
            // Full recipe rows (powers the Inventory "Used by" mapping).
            recipes: rowsByFlavor.get(flavorKey(p.name, f.name)) ?? [],
            // Recipe items with no stock row in any cart: sales of this
            // flavor warn instead of deducting. Empty = fully covered.
            missingItems: (itemsByFlavor.get(flavorKey(p.name, f.name)) ?? [])
              .filter((item) => !knownItems.has(String(item ?? "").trim())),
          })),
          recipeCount: recipeCount.get(p.name) ?? 0,
          orderLines: orderRefs.get(p.name) ?? 0,
        };
      }),
    });
  } catch (err) {
    return next(err);
  }
});

// POST /api/products (OWNER) — add a catalog product, optionally with
// per-flavor rows.
// Body: { name*, category?, basePrice*, flavorIds?[], flavors?[] }
// flavors[] entries: { flavorId? | name?, unitPrice?, recipes?[] } where
// recipes[] = { itemName*, amountPerUnit* }. Unknown flavor names are
// auto-created (same as the Excel import). unitPrice is absolute per flavor
// and defaults to basePrice; recipes are optional (warn, don't block).
router.post("/products", requireAuth, requireRole("OWNER"), async (req, res, next) => {
  try {
    const { name, category, basePrice, flavorIds, flavors } = req.body ?? {};
    if (!validProductName(name)) {
      return res.status(400).json({ error: "name needs at least 2 letters (max 120 characters)" });
    }
    const price = validPrice(basePrice);
    if (price === null) {
      return res.status(400).json({ error: "basePrice must be a positive number" });
    }
    const legacyIds = Array.isArray(flavorIds) ? [...new Set(flavorIds.map(Number))] : [];
    if (!(await flavorByIdOr404(legacyIds))) {
      return res.status(404).json({ error: "One or more flavors not found" });
    }
    const resolved = await resolveFlavorEntries(flavors ?? []);
    if (resolved.error) {
      const status = /not found/i.test(resolved.error) ? 404 : 400;
      return res.status(status).json({ error: resolved.error });
    }
    const ids = [...new Set([...legacyIds, ...resolved.ids])];
    // Per-flavor overrides: absolute unit prices + recipe rows, keyed by id.
    const priceById = new Map();
    const recipesById = new Map();
    for (const e of Array.isArray(flavors) ? flavors : []) {
      if (e === null || typeof e !== "object") continue;
      const rawId = e.flavorId ?? e.id;
      let key = null;
      if (typeof rawId === "number" || (typeof rawId === "string" && /^\d+$/.test(rawId.trim()))) {
        key = Number(rawId);
      } else if (e.name !== undefined) {
        key = resolved.idByName.get(String(e.name).trim().toLowerCase()) ?? null;
      }
      if (key === null || !ids.includes(Number(key))) continue;
      if (e.unitPrice !== undefined) {
        const unit = validPrice(e.unitPrice);
        if (unit === null) {
          return res.status(400).json({ error: `unitPrice for a flavor must be a positive number` });
        }
        priceById.set(Number(key), unit);
      }
      if (e.recipes !== undefined) {
        if (!Array.isArray(e.recipes)) {
          return res.status(400).json({ error: `recipes for a flavor must be an array` });
        }
        const rows = [];
        for (const r of e.recipes) {
          const row = validRecipeRow(r);
          if (!row) {
            return res.status(400).json({ error: `recipe rows need itemName (1-120 chars) and amountPerUnit > 0` });
          }
          rows.push(row);
        }
        recipesById.set(Number(key), rows);
      }
    }
    const productName = String(name).trim();
    const clash = await prisma.product.findMany();
    if (clash.some((p) => p.name.toLowerCase() === productName.toLowerCase())) {
      return res.status(409).json({ error: `Product "${productName}" already exists` });
    }
    const flavorPrices = {};
    for (const [id, unit] of priceById) {
      const f = resolved.byId.get(Number(id));
      if (f && unit !== price) flavorPrices[f.name] = unit;
    }
    const product = await prisma.product.create({
      data: {
        name: productName,
        category: category ? String(category).slice(0, 60) : undefined,
        basePrice: price,
        ...(ids.length ? { flavorIds: ids } : {}),
        ...(Object.keys(flavorPrices).length ? { flavorPrices } : {}),
      },
      include: { flavors: true },
    });
    let recipesCreated = 0;
    const unmatchedItems = [];
    const invNames = new Set(
      (await prisma.inventoryItem.findMany({ select: { name: true } }))
        .map((r) => String(r.name ?? "").trim())
        .filter(Boolean)
    );
    for (const [id, rows] of recipesById) {
      const f = resolved.byId.get(Number(id));
      if (!f || rows.length === 0) continue;
      for (const r of rows) {
        if (!invNames.has(r.itemName)) unmatchedItems.push({ flavor: f.name, itemName: r.itemName });
      }
      const out = await upsertRecipeRows(productName, f.name, rows);
      if (out.error) return res.status(400).json({ error: out.error });
      recipesCreated += out.created;
    }
    return res.status(201).json({
      product: { ...product, flavorPrices },
      flavorsCreated: resolved.created.length,
      recipesCreated,
      // Recipe items with no stock row anywhere: warn, don't block (same as
      // the Excel import philosophy). Sales using them warn instead of
      // deducting until a matching inventory row exists.
      unmatchedItems,
    });
  } catch (err) {
    if (err.code === "P2002") return res.status(409).json({ error: "Product already exists" });
    return next(err);
  }
});

// PATCH /api/products/:id (OWNER) — category/price/flavor links, per-flavor
// prices, and per-flavor recipe rows.
// Price applies to future sales only; history keeps its recorded totals.
// Body: { category?, basePrice?, addFlavorIds?[], removeFlavorIds?[],
//   flavorPrices? { [flavorName]: price | null }, addRecipes?[], removeRecipes?[] }
// addRecipes[] = { flavor*, itemName*, amountPerUnit* } (upsert);
// removeRecipes[] = { flavor*, itemName* }. Removing a flavor that still has
// recipe rows is rejected with 409 (delete the rows first).
router.patch("/products/:id", requireAuth, requireRole("OWNER"), async (req, res, next) => {
  try {
    const { category, basePrice, addFlavorIds, removeFlavorIds, flavorPrices, addRecipes, removeRecipes } = req.body ?? {};
    if (
      category === undefined &&
      basePrice === undefined &&
      addFlavorIds === undefined &&
      removeFlavorIds === undefined &&
      flavorPrices === undefined &&
      addRecipes === undefined &&
      removeRecipes === undefined
    ) {
      return res.status(400).json({ error: "provide category, basePrice, flavorIds, flavorPrices, or recipes" });
    }
    const existing = await prisma.product.findUnique({
      where: { id: Number(req.params.id) },
      include: { flavors: true },
    });
    if (!existing) return res.status(404).json({ error: "Product not found" });
    const data = {};
    if (category !== undefined) data.category = String(category).slice(0, 60) || "Fries";
    if (basePrice !== undefined) {
      const price = validPrice(basePrice);
      if (price === null) {
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
      if (removes.size > 0) {
        const maps = await prisma.ingredientMap.findMany({ where: { productName: existing.name } });
        const guarded = [...removes]
          .map((id) => (existing.flavors ?? []).find((f) => Number(f.id) === Number(id)))
          .filter((f) => f && maps.some((m) => m.flavor === f.name))
          .map((f) => f.name);
        if (guarded.length > 0) {
          return res.status(409).json({
            error: `Cannot remove flavor(s) ${guarded.join(", ")}: recipe rows still reference them — delete the rows first`,
            flavors: guarded,
          });
        }
      }
      for (const id of adds) current.add(id);
      for (const id of removes) current.delete(id);
      data.flavorIds = [...current];
      // Drop price overrides for unlinked flavors so stale keys can't linger.
      const removedNames = new Set(
        [...removes].map((id) => (existing.flavors ?? []).find((f) => Number(f.id) === Number(id))?.name).filter(Boolean)
      );
      if (removedNames.size > 0) {
      const merged = { ...(data.flavorPrices ?? existing.flavorPrices ?? {}) };
        for (const n of removedNames) delete merged[n];
        data.flavorPrices = merged;
      }
    }
    if (flavorPrices !== undefined) {
      if (flavorPrices === null || typeof flavorPrices !== "object" || Array.isArray(flavorPrices)) {
        return res.status(400).json({ error: "flavorPrices must be an object of flavor name to price" });
      }
      const merged = { ...(existing.flavorPrices ?? {}) };
      const linked = new Set([...current].map(Number));
      const allFlavors = await prisma.flavor.findMany();
      const byName = new Map(allFlavors.map((f) => [String(f.name).toLowerCase(), f]));
      for (const [rawName, rawPrice] of Object.entries(flavorPrices)) {
        const name = String(rawName).trim();
        const hit = byName.get(name.toLowerCase());
        if (!hit || !linked.has(Number(hit.id))) {
          return res.status(404).json({ error: `Flavor "${name}" is not linked to this product` });
        }
        if (rawPrice === null) {
          delete merged[hit.name];
        } else {
          const unit = validPrice(rawPrice);
          if (unit === null) {
            return res.status(400).json({ error: `unitPrice for "${hit.name}" must be a positive number` });
          }
          const base = data.basePrice ?? existing.basePrice;
          if (unit === base) delete merged[hit.name];
          else merged[hit.name] = unit;
        }
      }
      data.flavorPrices = merged;
    }
    const product = await prisma.product.update({
      where: { id: existing.id },
      data,
      include: { flavors: { orderBy: { name: "asc" } } },
    });
    let recipesChanged = 0;
    const unmatchedItems = [];
    if (addRecipes !== undefined) {
      if (!Array.isArray(addRecipes)) {
        return res.status(400).json({ error: "addRecipes must be an array" });
      }
      const byFlavor = new Map();
      for (const r of addRecipes) {
        const row = validRecipeRow(r);
        const flavor = String(r?.flavor ?? "").trim();
        if (!row || !flavor) {
          return res.status(400).json({ error: "addRecipes entries need flavor, itemName (1-120 chars), amountPerUnit > 0" });
        }
        if (!byFlavor.has(flavor)) byFlavor.set(flavor, []);
        byFlavor.get(flavor).push(row);
      }
      const invNames = new Set(
        (await prisma.inventoryItem.findMany({ select: { name: true } }))
          .map((r) => String(r.name ?? "").trim())
          .filter(Boolean)
      );
      for (const [flavor, rows] of byFlavor) {
        for (const r of rows) {
          if (!invNames.has(r.itemName)) unmatchedItems.push({ flavor, itemName: r.itemName });
        }
        const out = await upsertRecipeRows(existing.name, flavor, rows);
        if (out.error) return res.status(400).json({ error: out.error });
        recipesChanged += out.created;
      }
    }
    if (removeRecipes !== undefined) {
      if (!Array.isArray(removeRecipes)) {
        return res.status(400).json({ error: "removeRecipes must be an array" });
      }
      for (const r of removeRecipes) {
        const flavor = String(r?.flavor ?? "").trim();
        const itemName = String(r?.itemName ?? "").trim();
        if (!flavor || !itemName) {
          return res.status(400).json({ error: "removeRecipes entries need flavor and itemName" });
        }
        await prisma.ingredientMap.deleteMany({ where: { productName: existing.name, flavor, itemName } });
      }
    }
    return res.json({ product, recipesChanged, unmatchedItems });
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

// PATCH /api/flavors/:id (OWNER) — rename a flavor, rewriting recipe rows
// (keyed by flavor name) and per-flavor price overrides in one transaction.
// Body: { name* }
router.patch("/flavors/:id", requireAuth, requireRole("OWNER"), async (req, res, next) => {
  try {
    const nextName = String(req.body?.name ?? "").trim();
    if (!nextName || nextName.length > 60) {
      return res.status(400).json({ error: "name must be 1-60 characters" });
    }
    const existing = await prisma.flavor.findUnique({ where: { id: Number(req.params.id) } });
    if (!existing) return res.status(404).json({ error: "Flavor not found" });
    if (nextName.toLowerCase() === existing.name.toLowerCase()) {
      return res.status(400).json({ error: "New name is the same as the current name" });
    }
    const clash = await prisma.flavor.findMany();
    if (clash.some((f) => f.id !== existing.id && f.name.toLowerCase() === nextName.toLowerCase())) {
      return res.status(409).json({ error: `Flavor "${nextName}" already exists` });
    }
    const outcome = await prisma.runTransaction(async (tx) => {
      // Reads first (Firestore bans reads after writes inside a txn).
      const maps = await tx.ingredientMap.findMany({ where: { flavor: existing.name } });
      const products = await tx.product.findMany();
      const updated = await tx.flavor.update({
        where: { id: existing.id },
        data: { name: nextName },
      });
      for (const m of maps) {
        tx.txn.update(tx._firestore.collection("ingredientMaps").doc(String(m.id)), {
          flavor: nextName,
        });
      }
      let pricesRewritten = 0;
      for (const p of products) {
        if (p.flavorPrices && p.flavorPrices[existing.name] !== undefined) {
          const merged = { ...p.flavorPrices };
          merged[nextName] = merged[existing.name];
          delete merged[existing.name];
          await tx.product.update({ where: { id: p.id }, data: { flavorPrices: merged } });
          pricesRewritten += 1;
        }
      }
      return { updated, mapsUpdated: maps.length, pricesRewritten };
    });
    return res.json({ flavor: outcome.updated, mapsUpdated: outcome.mapsUpdated, pricesRewritten: outcome.pricesRewritten });
  } catch (err) {
    return next(err);
  }
});

// DELETE /api/flavors/:id (OWNER) — blocked while products link it or recipe
// rows reference its name.
router.delete("/flavors/:id", requireAuth, requireRole("OWNER"), async (req, res, next) => {
  try {
    const existing = await prisma.flavor.findUnique({ where: { id: Number(req.params.id) } });
    if (!existing) return res.status(404).json({ error: "Flavor not found" });
    const [products, maps] = await Promise.all([
      prisma.product.findMany(),
      prisma.ingredientMap.findMany({ where: { flavor: existing.name } }),
    ]);
    const linked = products
      .filter((p) => (p.flavorIds ?? []).map(Number).includes(Number(existing.id)))
      .map((p) => p.name);
    if (linked.length > 0 || maps.length > 0) {
      return res.status(409).json({
        error: `Cannot delete flavor "${existing.name}": used by ${linked.length} product(s) and ${maps.length} recipe row(s)`,
        products: linked,
        recipeRows: maps.length,
      });
    }
    await prisma.flavor.delete({ where: { id: existing.id } });
    return res.json({ deleted: true });
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "Flavor not found" });
    return next(err);
  }
});

export default router;
