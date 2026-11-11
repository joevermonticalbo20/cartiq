import { Router } from "express";
import { db as prisma, bumpCatalogVersion } from "../firestore.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { emit } from "./events.js";
import { sortFlavorRows } from "../services/flavor_order.js";
import { validateName } from "../services/validation.js";
import {
  IMAGE_MAX_BYTES,
  IMAGE_PREFIX,
  imageDoc,
  imageUrlFor,
  servedImageUrl,
  uploadedImageTimes,
} from "../services/product_images.js";

const router = Router();

// The menu changed: bump the catalog version the POS app polls (1 read) so
// every open device refreshes without being asked. Best-effort only — a
// version bump must never fail the mutation itself.
async function touchCatalog() {
  try {
    await bumpCatalogVersion();
  } catch {
    /* best-effort */
  }
}

// The menu changed: tell every open dashboard so it can refresh the list
// instead of waiting for a manual reload. The SSE frame only carries "the
// catalog moved" - the client refetches what it shows.
//
// Best-effort only: a failed broadcast must never fail the mutation that
// caused it (the version bump above is the fallback the clients poll).
function announceProductChange(payload = {}) {
  try {
    emit("product:updated", payload);
  } catch {
    /* best-effort */
  }
}

function countLetters(s) {
  const m = String(s ?? "").match(/\p{L}/gu);
  return m ? m.length : 0;
}

function validProductName(name) {
  return validateName(name, "Product name", 120).ok;
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
      const nameCheck = validateName(asObj ? (asObj.name ?? "") : (e ?? ""), "Flavor name", 60);
      if (!nameCheck.ok) {
        return { error: nameCheck.error };
      }
      const name = nameCheck.value;
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

// Resolve the full desired flavor link list for PATCH /products/:id exactly
// as the Products edit form sends it (`flavors: [{ name, recipes }]`).
// Unknown names are auto-created, like POST /products. Returns
// { nextIds, removedNames, flavorsChanged } or { error }.
//
// Removal guard: a flavor that still has recipe rows for this product
// (after any removeRecipes cleanup in the same request) is rejected with
// { error, guarded }, matching the existing addFlavorIds/removeFlavorIds
// 409 so the edit form never leaves orphan recipe rows.
async function applyFullFlavorList({ existing, flavors, removeRecipes }) {
  if (!Array.isArray(flavors)) return { error: "flavors must be an array" };
  const resolved = await resolveFlavorEntries(flavors);
  if (resolved.error) return { error: resolved.error };
  const nextIds = resolved.ids.map(Number);
  const priorIds = (existing.flavorIds ?? existing.flavors.map((f) => f.id)).map(Number);
  const removedIds = priorIds.filter((id) => !nextIds.includes(id));
  const removedNames = removedIds
    .map((id) => (existing.flavors ?? []).find((f) => Number(f.id) === Number(id))?.name)
    .filter(Boolean);
  if (removedIds.length > 0) {
    const maps = await prisma.ingredientMap.findMany({ where: { productName: existing.name } });
    const requestedDeletes = Array.isArray(removeRecipes) ? removeRecipes : [];
    const guarded = removedIds
      .map((id) => (existing.flavors ?? []).find((f) => Number(f.id) === Number(id)))
      .filter(Boolean)
      .filter((f) => maps.some((m) => m.flavor === f.name &&
        !requestedDeletes.some((r) =>
          String(r?.flavor ?? "").trim() === f.name &&
          String(r?.itemName ?? "").trim() === m.itemName)))
      .map((f) => f.name);
    if (guarded.length > 0) return { error: "guarded", guarded };
  }
  const identical =
    nextIds.length === priorIds.length &&
    nextIds.every((id) => priorIds.includes(id));
  return {
    nextIds,
    removedNames,
    flavorsChanged: identical
      ? 0
      : nextIds.filter((id) => !priorIds.includes(id)).length + removedIds.length,
  };
}

// Validate one recipe row { itemName, amountPerUnit }. Returns the cleaned
// row or null.
function validRecipeRow(r) {
  const checked = validateName(r?.itemName, "Recipe item", 120);
  if (!checked.ok) return null;
  const amount = Number(r?.amountPerUnit);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { itemName: checked.value, amountPerUnit: amount };
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
// usage and stock coverage so the UI can explain delete blocks and warn on
// missing recipe rows. Order counts were removed: they read the whole orders
// history on every list call and burned the Firestore read budget.
router.get("/products", requireAuth, async (req, res, next) => {
  try {
    const [products, maps, invRows, uploadTimes] = await Promise.all([
      prisma.product.findMany({
        include: { flavors: { orderBy: { name: "asc" } } },
        orderBy: { name: "asc" },
      }),
      prisma.ingredientMap.findMany(),
      prisma.inventoryItem.findMany({ select: { name: true } }),
      uploadedImageTimes(),
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
    return res.json({
      data: products.map((p) => {
        const flavorPrices = p.flavorPrices ?? {};
        return {
          id: p.id,
          name: p.name,
          category: p.category,
          basePrice: p.basePrice,
          // Missing on pre-archive docs means active (backwards compatible).
          active: p.active !== false,
          isBestSeller: p.isBestSeller === true,
          imageUrl: servedImageUrl(req, p, uploadTimes),
          flavorPrices,
          // Size-aware order: Medium, Large, XL 40, XL 50 — never the
          // alphabetical Large/Medium that misled the pickers.
          flavors: sortFlavorRows(p.flavors ?? []).map((f) => ({
            id: f.id,
            name: f.name,
            // Absolute per-flavor price; falls back to the product base price
            // when no override was saved for this flavor.
            unitPrice: Number(flavorPrices[f.name] ?? p.basePrice),
            hasCustomPrice: flavorPrices[f.name] !== undefined,
            recipeCount: recipeByFlavor.get(flavorKey(p.name, f.name)) ?? 0,
            // Full recipe rows (powers the Inventory "Used by" mapping).
            recipes: rowsByFlavor.get(flavorKey(p.name, f.name)) ?? [],
            missingItems: (itemsByFlavor.get(flavorKey(p.name, f.name)) ?? [])
              .filter((item) => !knownItems.has(String(item ?? "").trim())),
          })),
          recipeCount: recipeCount.get(p.name) ?? 0,
          // Recipe rows on flavor "" are the product-level base rows (the
          // frozen packs + the seasoning powder that every size uses). They
          // must show for flavor parents too, so "Used by" and the recipe
          // editor see them; flat products keep working the same way.
          recipes: rowsByFlavor.get(flavorKey(p.name, "")) ?? [],
          missingItems: (itemsByFlavor.get(flavorKey(p.name, "")) ?? [])
            .filter((item) => !knownItems.has(String(item ?? "").trim())),
        };
      }),
    });
  } catch (err) {
    return next(err);
  }
});

// POST /api/products (OWNER) — add a catalog product, optionally with
// per-flavor rows.
// Body: { name*, category?, basePrice*, flavorIds?[], flavors?[], imageUrl? }
// flavors[] entries: { flavorId? | name?, unitPrice?, recipes?[] } where
// recipes[] = { itemName*, amountPerUnit* }. Unknown flavor names are
// auto-created (same as the Excel import). unitPrice is absolute per flavor
// and defaults to basePrice; recipes are optional (warn, don't block).
router.post("/products", requireAuth, requireRole("OWNER"), async (req, res, next) => {
  try {
    const { name, category, basePrice, cost, flavorIds, flavors, imageUrl, isBestSeller } = req.body ?? {};
    if (!validProductName(name)) {
      return res.status(400).json({ error: "name needs at least 2 letters (max 120 characters)" });
    }
    const price = validPrice(basePrice);
    if (price === null) {
      return res.status(400).json({ error: "basePrice must be a positive number" });
    }
    // Optional cost per unit. It is what the Margin readout is based on; the
    // POS still charges `basePrice`. Omitted/null means "unknown" - the margin
    // then shows "—" instead of a fake 0%.
    const costProvided = cost !== undefined && cost !== null && cost !== "";
    const costValue = costProvided ? validPrice(cost) : null;
    if (costProvided && costValue === null) {
      return res.status(400).json({ error: "cost must be a positive number (or leave it empty)" });
    }
    if (costValue !== null && costValue > price) {
      return res.status(400).json({ error: "cost cannot be higher than the selling price" });
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
        ...(costValue !== null ? { cost: costValue } : {}),
        ...(ids.length ? { flavorIds: ids } : {}),
        ...(Object.keys(flavorPrices).length ? { flavorPrices } : {}),
        ...(imageUrl !== undefined && imageUrl !== null && String(imageUrl).trim() !== ""
          ? { imageUrl: String(imageUrl).trim() }
          : {}),
        ...(isBestSeller === true ? { isBestSeller: true } : {}),
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
    await touchCatalog();
    announceProductChange({ id: product.id, name: productName, scope: "product" });
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
//   flavors?[], flavorPrices? { [flavorName]: price | null }, addRecipes?[], removeRecipes?[] }
// flavors[] = the full desired flavor link list: numeric ids, bare name
// strings, or { flavorId?, name? } (unknown names auto-created, same as POST).
// A flavor removed while recipe rows still reference it is rejected with 409
// (delete the rows first via removeRecipes in the same request).
// addRecipes[] = { flavor*, itemName*, amountPerUnit* } (upsert);
// removeRecipes[] = { flavor*, itemName* }. Removing a flavor that still has
// recipe rows is rejected with 409 (delete the rows first).
router.patch("/products/:id", requireAuth, requireRole("OWNER"), async (req, res, next) => {
  try {
    const { category, basePrice, cost, active, addFlavorIds, removeFlavorIds, flavors, flavorPrices, addRecipes, removeRecipes, imageUrl, isBestSeller } = req.body ?? {};
    if (
      category === undefined &&
      basePrice === undefined &&
      cost === undefined &&
      active === undefined &&
      addFlavorIds === undefined &&
      removeFlavorIds === undefined &&
      flavors === undefined &&
      flavorPrices === undefined &&
      addRecipes === undefined &&
      removeRecipes === undefined &&
      imageUrl === undefined &&
      isBestSeller === undefined
    ) {
      return res.status(400).json({ error: "provide category, basePrice, cost, active, flavorIds, flavorPrices, recipes, imageUrl, or isBestSeller" });
    }
    const existing = await prisma.product.findUnique({
      where: { id: Number(req.params.id) },
      include: { flavors: true },
    });
    if (!existing) return res.status(404).json({ error: "Product not found" });
    const data = {};
    if (category !== undefined) data.category = String(category).slice(0, 60) || "Fries";
    // Archive switch: active=false hides the product from the POS catalog
    // but keeps history/reports intact. Restore with active=true.
    if (active !== undefined) {
      if (typeof active !== "boolean") {
        return res.status(400).json({ error: "active must be true or false" });
      }
      data.active = active;
    }
    if (basePrice !== undefined) {
      const price = validPrice(basePrice);
      if (price === null) {
        return res.status(400).json({ error: "basePrice must be a positive number" });
      }
      data.basePrice = price;
    }
    // Cost per unit: what the Margin readout is based on. Null clears it
    // (unknown cost), and it may never exceed the selling price.
    if (cost !== undefined) {
      if (cost === null || cost === "") {
        data.cost = null;
      } else {
        const costValue = validPrice(cost);
        if (costValue === null) {
          return res.status(400).json({ error: "cost must be a positive number (or leave it empty)" });
        }
        const selling = data.basePrice ?? Number(existing.basePrice);
        if (costValue > selling) {
          return res.status(400).json({ error: "cost cannot be higher than the selling price" });
        }
        data.cost = costValue;
      }
    }
    // Product image: absolute URL or null to clear. Empty string clears too.
    if (imageUrl !== undefined) {
      if (imageUrl === null || String(imageUrl).trim() === "") {
        data.imageUrl = null;
      } else {
        data.imageUrl = String(imageUrl).trim();
      }
    }
    // Best-seller flag: the star toggle on the Products page. The POS
    // "Best Sellers" filter has read this field all along.
    if (isBestSeller !== undefined) {
      if (typeof isBestSeller !== "boolean") {
        return res.status(400).json({ error: "isBestSeller must be true or false" });
      }
      data.isBestSeller = isBestSeller;
    }
    const current = new Set(existing.flavorIds ?? existing.flavors.map((f) => f.id));
    let fullFlavorUpdate = null;
    if (flavors !== undefined) {
      fullFlavorUpdate = await applyFullFlavorList({ existing, flavors, removeRecipes });
      if (fullFlavorUpdate.error && fullFlavorUpdate.error !== "guarded") {
        return res.status(400).json({ error: fullFlavorUpdate.error });
      }
      if (fullFlavorUpdate.error === "guarded") {
        return res.status(409).json({
          error: `Cannot remove flavor(s) ${fullFlavorUpdate.guarded.join(", ")}: recipe rows still reference them — delete the rows first`,
          flavors: fullFlavorUpdate.guarded,
        });
      }
    }
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
    // Full-list `flavors` update (Products edit form). Already guarded by
    // applyFullFlavorList above: any flavor still referenced by recipe
    // rows was rejected with 409 before this point.
    let flavorsChanged = 0;
    if (fullFlavorUpdate) {
      if (fullFlavorUpdate.flavorsChanged > 0) {
        data.flavorIds = fullFlavorUpdate.nextIds;
        flavorsChanged = fullFlavorUpdate.flavorsChanged;
        // Unlinked flavors must drop any price overrides so stale keys
        // can't linger. (Explicit flavorPrices in this request wins below.)
        if (fullFlavorUpdate.removedNames.length > 0 && data.flavorPrices === undefined) {
          const merged = { ...(existing.flavorPrices ?? {}) };
          for (const n of fullFlavorUpdate.removedNames) delete merged[n];
          data.flavorPrices = merged;
        }
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
    const product = Object.keys(data).length > 0
      ? await prisma.product.update({
        where: { id: existing.id },
        data,
        include: { flavors: { orderBy: { name: "asc" } } },
      })
      // Recipe-only patches (addRecipes/removeRecipes) carry no product
      // fields — Firestore rejects empty updates, so re-read instead.
      : await prisma.product.findUnique({
        where: { id: existing.id },
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
        // An explicit empty flavor means the flat (size-to-product migration) product.
        const flavor = r?.flavor === undefined || r?.flavor === null ? "" : String(r.flavor).trim();
        if (!row) {
          return res.status(400).json({ error: "addRecipes entries need itemName (1-120 chars), amountPerUnit > 0" });
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
        const flavor = r?.flavor === undefined || r?.flavor === null ? "" : String(r.flavor).trim();
        const itemName = String(r?.itemName ?? "").trim();
        if (!itemName) {
          return res.status(400).json({ error: "removeRecipes entries need itemName" });
        }
        await prisma.ingredientMap.deleteMany({ where: { productName: existing.name, flavor, itemName } });
      }
    }
    await touchCatalog();
    announceProductChange({ id: existing.id, name: existing.name, scope: "product" });
    return res.json({ product, flavorsChanged, recipesChanged, unmatchedItems });
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
    // Recipe rows were rewritten through the raw txn handle (bypasses the
    // read cache) — invalidate so the next GET sees the new names.
    prisma._invalidateModel("ingredientMaps");
    await touchCatalog();
    announceProductChange({ id: existing.id, name: nextName, scope: "product" });
    return res.json({ product: outcome.updated, mapsUpdated: outcome.mapsUpdated });
  } catch (err) {
    return next(err);
  }
});

// DELETE /api/products/:id (OWNER) — blocked only while order lines still
// reference the name (history truth). A product that was never sold deletes
// cleanly together with its recipe rows: those rows are keyed by product name
// and would otherwise be orphans pointing at a product that no longer exists
// (which would keep deducting stock for a deleted product).
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
    if (usedInOrders > 0) {
      return res.status(409).json({
        error: `Cannot delete "${existing.name}": referenced by ${usedInOrders} order line(s)`,
        orderLines: usedInOrders,
        recipeRows: maps.length,
      });
    }
    // The product's own recipe rows die with it.
    if (maps.length > 0) {
      await prisma.ingredientMap.deleteMany({ where: { productName: existing.name } });
    }
    await imageDoc(existing.id).delete();
    await prisma.product.delete({ where: { id: existing.id } });
    await touchCatalog();
    announceProductChange({ id: existing.id, name: existing.name, scope: "product", deleted: true });
    return res.json({ deleted: true, removedRecipeRows: maps.length });
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "Product not found" });
    return next(err);
  }
});

// POST /api/products/:id/image (OWNER) — store a cropped product photo.
// Body: { data*: base64, mime*: "image/jpeg" | "image/png" | "image/webp" }.
// 512 KB decoded max. Returns { imageUrl, updatedAt } — the URL the product
// list/catalog will serve for this product (replacing any pasted URL).
router.post("/products/:id/image", requireAuth, requireRole("OWNER"), async (req, res, next) => {
  try {
    const existing = await prisma.product.findUnique({ where: { id: Number(req.params.id) } });
    if (!existing) return res.status(404).json({ error: "Product not found" });
    const { data, mime } = req.body ?? {};
    const m = String(mime ?? "").trim().toLowerCase();
    const prefix = IMAGE_PREFIX[m];
    if (!prefix || typeof data !== "string" || !data.startsWith(prefix)) {
      return res.status(400).json({ error: "image must be a base64 JPEG, PNG, or WebP" });
    }
    const bytes = Buffer.from(data, "base64");
    if (bytes.length === 0) {
      return res.status(400).json({ error: "image data is empty" });
    }
    if (bytes.length > IMAGE_MAX_BYTES) {
      return res.status(413).json({ error: `image too large (max ${Math.round(IMAGE_MAX_BYTES / 1024)} KB)` });
    }
    const updatedAtMs = Date.now();
    await imageDoc(existing.id).set({
      mime: m,
      data,
      bytes: bytes.length,
      updatedAtMs,
      updatedAt: new Date(),
    });
    // The POS tile shows this photo, so the catalog version moves too.
    await touchCatalog();
    announceProductChange({ id: existing.id, name: existing.name, scope: "product", image: true });
    return res.json({ imageUrl: imageUrlFor(req, existing.id, updatedAtMs), updatedAt: updatedAtMs });
  } catch (err) {
    return next(err);
  }
});

// GET /api/products/:id/image (PUBLIC) — the photo bytes for <img> tags on
// the dashboard and the POS cards (they cannot send an auth header). CORS is
// open so the dashboard can re-crop an existing upload on a <canvas>.
router.get("/products/:id/image", async (req, res, next) => {
  try {
    const snap = await imageDoc(Number(req.params.id)).get();
    if (!snap.exists) return res.status(404).json({ error: "No image for this product" });
    const { mime, data } = snap.data() ?? {};
    const buf = Buffer.from(String(data ?? ""), "base64");
    res.setHeader("Content-Type", mime || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.send(buf);
  } catch (err) {
    return next(err);
  }
});

// DELETE /api/products/:id/image (OWNER) — remove the uploaded photo.
router.delete("/products/:id/image", requireAuth, requireRole("OWNER"), async (req, res, next) => {
  try {
    const existing = await prisma.product.findUnique({ where: { id: Number(req.params.id) } });
    if (!existing) return res.status(404).json({ error: "Product not found" });
    await imageDoc(existing.id).delete();
    await touchCatalog();
    announceProductChange({ id: existing.id, name: existing.name, scope: "product", image: true });
    return res.json({ deleted: true });
  } catch (err) {
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
    const nameCheck = validateName(req.body?.name, "Flavor name", 60);
    if (!nameCheck.ok) {
      return res.status(400).json({ error: nameCheck.error });
    }
    const flavorName = nameCheck.value;
    const existing = await prisma.flavor.findMany();
    if (existing.some((f) => f.name.toLowerCase() === flavorName.toLowerCase())) {
      return res.status(409).json({ error: `Flavor "${flavorName}" already exists` });
    }
    const flavor = await prisma.flavor.create({ data: { name: flavorName } });
    await touchCatalog();
    announceProductChange({ id: flavor.id, name: flavorName, scope: "flavor" });
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
    const nameCheck = validateName(req.body?.name, "Flavor name", 60);
    if (!nameCheck.ok) {
      return res.status(400).json({ error: nameCheck.error });
    }
    const nextName = nameCheck.value;
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
    // Same as product rename: maps + price keys moved under the raw handle.
    prisma._invalidateModel("ingredientMaps");
    await touchCatalog();
    announceProductChange({ id: existing.id, name: nextName, scope: "flavor" });
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
    await touchCatalog();
    announceProductChange({ id: existing.id, name: existing.name, scope: "flavor", deleted: true });
    return res.json({ deleted: true });
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "Flavor not found" });
    return next(err);
  }
});

export default router;

// The PATCH /products/:id handler tests the `flavors` full-list update
// through this export (unit-testable without HTTP machinery).
export { applyFullFlavorList };
