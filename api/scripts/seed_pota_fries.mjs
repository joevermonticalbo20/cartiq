// Pota Fries menu setup (production or emulator) — idempotent.
//
//   node scripts/seed_pota_fries.mjs            # dry run: prints the plan
//   node scripts/seed_pota_fries.mjs --apply    # writes
//
// What it creates / aligns:
//   1. Size options (flavor records) Medium / Large / XL 40 / XL 50 — the
//      client prices XL at either P40 or P50, so the POS offers both and the
//      cashier picks. Legacy "XL" is renamed to "XL 40" in place.
//   2. Eight flavor products ("Cheese Fries" ... "Honey Butter Fries"):
//      base price = Medium P20, Large P30, XL 40 / XL 50 via per-flavor
//      prices, linked to the size options, each with its product photo.
//   3. Three dip add-ons (category "Add-ons", P15): Cheese Dip,
//      Garlic Mayo Dip, Barbecue Dip.
//   4. Size-based pouch stock rows per location: Pouch Medium / Large / XL
//      (both XL choices deduct the XL pouch).
//   5. One seasoning powder stock row per flavor (2 kg) and a 15 g recipe
//      row per flavor, so every flavor deducts its powder on sale. Cheese /
//      Sour Cream / BBQ share the existing powder items; the five new
//      flavors get their own ("Chili Cheese Powder", "Chili BBQ Powder",
//      "Caramel Powder", "Sweet Corn Powder", "Honey Butter Powder").
//   6. Archives the legacy "Flavored Fries" product (history kept).
//
// Safe to re-run: existing rows are updated only where this script owns the
// field (prices, links, images, recipe amounts). Inventory stock is only
// created when missing — a real count is never overwritten.
import "dotenv/config";
import { db } from "../src/firestore.js";
import { FROZEN_PACKS_PER_UNIT, POWDER_KG_PER_UNIT } from "../src/services/recipe_defaults.js";

const APPLY = process.argv.includes("--apply");
const IMAGE_BASE = "https://cartiq-8e46f.web.app/products";

const SIZES = [
  { name: "Medium", price: 20 },
  { name: "Large", price: 30 },
  // XL has two prices (client: "it can be 40 or 50") — the POS shows both
  // choices; both deduct the XL pouch.
  { name: "XL 40", price: 40 },
  { name: "XL 50", price: 50 },
];
const LEGACY_XL = "XL"; // renamed to "XL 40" on first run
const POUCH_BY_SIZE = {
  Medium: "Pouch Medium",
  Large: "Pouch Large",
  "XL 40": "Pouch XL",
  "XL 50": "Pouch XL",
};

// flavor name -> product. `powder` is the seasoning stock item deducted per
// serving (15 g, house convention) for every flavor.
const FLAVOR_PRODUCTS = [
  { name: "Cheese Fries", slug: "cheese", powder: "Cheese Powder" },
  { name: "Chili Cheese Fries", slug: "chili-cheese", powder: "Chili Cheese Powder" },
  { name: "BBQ Fries", slug: "bbq", powder: "BBQ Powder" },
  { name: "Chili BBQ Fries", slug: "chili-bbq", powder: "Chili BBQ Powder" },
  { name: "Caramel Fries", slug: "caramel", powder: "Caramel Powder" },
  { name: "Sweet Corn Fries", slug: "sweet-corn", powder: "Sweet Corn Powder" },
  { name: "Sour Cream Fries", slug: "sour-cream", powder: "Sour Cream Powder" },
  { name: "Honey Butter Fries", slug: "honey-butter", powder: "Honey Butter Powder" },
];
const DIPS = ["Cheese Dip", "Garlic Mayo Dip", "Barbecue Dip"];
const LEGACY_PRODUCT = "Flavored Fries";

const POUCH_STOCK = { unit: "pcs", stock: 150, threshold: 50, source: "MANUAL" };
const POWDER_STOCK = { unit: "kg", stock: 2.0, threshold: 1.0, source: "MANUAL" };

const plan = [];
const note = (line) => plan.push(APPLY ? line : `[dry] ${line}`);

async function upsertFlavor(name) {
  const existing = await db.flavor.findUnique({ where: { name } });
  if (existing) return existing;
  note(`+ flavor "${name}"`);
  if (!APPLY) return { id: null, name };
  return db.flavor.create({ data: { name } });
}

// Rename a flavor everywhere it is referenced (same rewrite the API does):
// recipe rows keyed by flavor name + per-flavor price keys on products.
// No-op when the old name is gone or the new name already exists.
async function renameFlavor(oldName, newName) {
  const old = await db.flavor.findUnique({ where: { name: oldName } });
  if (!old) return;
  const target = await db.flavor.findUnique({ where: { name: newName } });
  if (target) return;
  note(`~ rename flavor "${oldName}" -> "${newName}"`);
  if (!APPLY) return;
  const maps = await db.ingredientMap.findMany({ where: { flavor: oldName } });
  for (const m of maps) {
    await db.collection("ingredientMaps").doc(String(m.id)).update({ flavor: newName });
  }
  const products = await db.product.findMany();
  for (const p of products) {
    if (p.flavorPrices && p.flavorPrices[oldName] !== undefined) {
      const merged = { ...p.flavorPrices };
      merged[newName] = merged[oldName];
      delete merged[oldName];
      await db.product.update({ where: { id: p.id }, data: { flavorPrices: merged } });
    }
  }
  await db.flavor.update({ where: { id: old.id }, data: { name: newName } });
}

async function upsertProduct({ name, category, basePrice, flavorIds, flavorPrices, imageUrl }) {
  const existing = await db.product.findUnique({ where: { name } });
  const data = {
    name,
    category,
    basePrice,
    flavorIds,
    flavorPrices,
    ...(imageUrl ? { imageUrl } : {}),
  };
  if (existing) {
    const wantsFlavors = JSON.stringify([...(existing.flavorIds ?? [])].sort()) !== JSON.stringify([...flavorIds].sort());
    const wantsPrices = JSON.stringify(existing.flavorPrices ?? {}) !== JSON.stringify(flavorPrices);
    const wantsImage = (existing.imageUrl ?? null) !== (imageUrl ?? null);
    const wantsPrice = Number(existing.basePrice) !== basePrice;
    const wantsCat = (existing.category ?? "") !== category;
    if (!wantsFlavors && !wantsPrices && !wantsImage && !wantsPrice && !wantsCat) {
      note(`= product "${name}" already aligned`);
      return existing;
    }
    note(`~ product "${name}" (${[wantsPrice && "price", wantsFlavors && "sizes", wantsPrices && "size prices", wantsImage && "image", wantsCat && "category"].filter(Boolean).join(", ")})`);
    if (!APPLY) return existing;
    return db.product.update({ where: { id: existing.id }, data });
  }
  note(`+ product "${name}" P${basePrice}`);
  if (!APPLY) return { id: null, name };
  return db.product.create({ data });
}

async function upsertInventoryRow(location, itemName, template) {
  const rows = await db.inventoryItems.findMany({
    where: { locationId: location.id, name: itemName },
  });
  if (rows[0]) {
    note(`= stock ${location.code} / ${itemName} exists (left untouched)`);
    return rows[0];
  }
  note(`+ stock ${location.code} / ${itemName} (${template.stock} ${template.unit})`);
  if (!APPLY) return null;
  return db.inventoryItems.create({
    data: { locationId: location.id, name: itemName, ...template },
  });
}

async function upsertRecipe(productName, flavor, itemName, amountPerUnit) {
  const rows = await db.ingredientMap.findMany({ where: { productName, flavor, itemName } });
  if (rows[0]) {
    if (Number(rows[0].amountPerUnit) !== amountPerUnit) {
      note(`~ recipe ${productName} / ${flavor || "(all sizes)"} / ${itemName} ${rows[0].amountPerUnit} -> ${amountPerUnit}`);
      if (APPLY) {
        await db.collection("ingredientMaps").doc(String(rows[0].id)).update({ amountPerUnit });
      }
    }
    return;
  }
  note(`+ recipe ${productName} / ${flavor || "(all sizes)"} / ${itemName} x${amountPerUnit}`);
  if (APPLY) {
    await db.ingredientMap.create({ data: { productName, flavor, itemName, amountPerUnit } });
  }
}

async function main() {
  const [locations, products] = await Promise.all([
    db.location.findMany({ orderBy: { code: "asc" } }),
    db.product.findMany(),
  ]);

  // 1. Size options (stored as flavors; the POS shows them as the price
  //    choices when a flavor product is tapped). The first run upgrades the
  //    old single "XL" to the two-price "XL 40" / "XL 50" pair.
  await renameFlavor(LEGACY_XL, "XL 40");
  const sizeFlavor = {};
  for (const s of SIZES) sizeFlavor[s.name] = await upsertFlavor(s.name);
  const sizeIds = SIZES.map((s) => Number(sizeFlavor[s.name]?.id)).filter((id) => Number.isFinite(id) && id > 0);

  // 2. Eight flavor products with photos + size prices.
  for (const fp of FLAVOR_PRODUCTS) {
    const flavorPrices = {};
    for (const s of SIZES) if (s.price !== SIZES[0].price) flavorPrices[s.name] = s.price;
    await upsertProduct({
      name: fp.name,
      category: "Fries",
      basePrice: SIZES[0].price,
      flavorIds: sizeIds,
      flavorPrices,
      imageUrl: `${IMAGE_BASE}/pota-fries-${fp.slug}.jpg`,
    });
  }

  // 3. Dip add-ons (their own POS cards under the Add-ons filter).
  for (const name of DIPS) {
    await upsertProduct({
      name,
      category: "Add-ons",
      basePrice: 15,
      flavorIds: [],
      flavorPrices: {},
    });
  }

  // 4. Pouch + seasoning stock per location (all locations, so a reactivated
  //    cart is ready). Existing rows are never overwritten — a real count
  //    stays a real count.
  const powderItems = [...new Set(FLAVOR_PRODUCTS.map((fp) => fp.powder).filter(Boolean))];
  for (const loc of locations) {
    for (const size of new Set(Object.values(POUCH_BY_SIZE))) {
      await upsertInventoryRow(loc, size, POUCH_STOCK);
    }
    for (const powder of powderItems) {
      await upsertInventoryRow(loc, powder, POWDER_STOCK);
    }
  }

  // 5. Recipes: the chosen size deducts its pouch (both XL choices -> XL
  //    pouch); every flavor deducts frozen fries + its 15 g powder.
  for (const fp of FLAVOR_PRODUCTS) {
    for (const s of SIZES) {
      await upsertRecipe(fp.name, s.name, POUCH_BY_SIZE[s.name], 1);
    }
    await upsertRecipe(fp.name, "", "Fries (frozen packs)", FROZEN_PACKS_PER_UNIT);
    if (fp.powder) {
      await upsertRecipe(fp.name, "", fp.powder, POWDER_KG_PER_UNIT);
    }
  }

  // 6. Archive the legacy product (kept in history/reports).
  const legacy = products.find((p) => p.name === LEGACY_PRODUCT);
  if (legacy && legacy.active !== false) {
    note(`~ archive product "${LEGACY_PRODUCT}" (hidden from POS, history kept)`);
    if (APPLY) {
      await db.product.update({ where: { id: legacy.id }, data: { active: false } });
    }
  } else if (legacy) {
    note(`= product "${LEGACY_PRODUCT}" already archived`);
  }

  console.log(`Mode: ${APPLY ? "APPLY (writing)" : "DRY RUN (no writes — add --apply to write)"}`);
  for (const line of plan) console.log(`  ${line}`);
  console.log(`\n${plan.length} plan line(s).`);

  if (APPLY) {
    const check = await db.product.findMany({ include: { flavors: true }, orderBy: { name: "asc" } });
    const fries = check.filter((p) => FLAVOR_PRODUCTS.some((fp) => fp.name === p.name));
    console.log("\n== VERIFY ==");
    for (const p of fries) {
      console.log(` ${p.name}: P${p.basePrice} sizes=[${(p.flavors ?? []).map((f) => f.name).join(", ")}] prices=${JSON.stringify(p.flavorPrices ?? {})} img=${p.imageUrl ? "yes" : "NO"}`);
    }
    const pouchRows = await db.inventoryItem.findMany({ where: { name: "Pouch Medium" } });
    console.log(` Pouch Medium stock rows: ${pouchRows.length} location(s)`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
