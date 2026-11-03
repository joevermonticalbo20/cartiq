// Pota Fries menu setup (production or emulator) — idempotent.
//
//   node scripts/seed_pota_fries.mjs            # dry run: prints the plan
//   node scripts/seed_pota_fries.mjs --apply    # writes
//
// What it creates / aligns:
//   1. Size options (flavor records) Medium / Large / XL.
//   2. Eight flavor products ("Cheese Fries" ... "Honey Butter Fries"):
//      base price = Medium P20, Large P30, XL P40 via per-flavor prices,
//      linked to the three size options, each with its product photo.
//   3. Three dip add-ons (category "Add-ons", P15): Cheese Dip,
//      Garlic Mayo Dip, Barbecue Dip.
//   4. Size-based pouch stock rows per location: Pouch Medium / Large / XL.
//   5. Recipes: the chosen size deducts its pouch; every flavor deducts
//      frozen fries (0.05 packs) and, when a house powder exists, 15 g of it.
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
  { name: "XL", price: 40 },
];
const POUCH_BY_SIZE = { Medium: "Pouch Medium", Large: "Pouch Large", XL: "Pouch XL" };

// flavor name -> product. `powder` is the house stock item when one exists.
const FLAVOR_PRODUCTS = [
  { name: "Cheese Fries", slug: "cheese", powder: "Cheese Powder" },
  { name: "Chili Cheese Fries", slug: "chili-cheese" },
  { name: "BBQ Fries", slug: "bbq", powder: "BBQ Powder" },
  { name: "Chili BBQ Fries", slug: "chili-bbq" },
  { name: "Caramel Fries", slug: "caramel" },
  { name: "Sweet Corn Fries", slug: "sweet-corn" },
  { name: "Sour Cream Fries", slug: "sour-cream", powder: "Sour Cream Powder" },
  { name: "Honey Butter Fries", slug: "honey-butter" },
];
const DIPS = ["Cheese Dip", "Garlic Mayo Dip", "Barbecue Dip"];
const LEGACY_PRODUCT = "Flavored Fries";

const POUCH_STOCK = { unit: "pcs", stock: 150, threshold: 50, source: "MANUAL" };

const plan = [];
const note = (line) => plan.push(APPLY ? line : `[dry] ${line}`);

async function upsertFlavor(name) {
  const existing = await db.flavor.findUnique({ where: { name } });
  if (existing) return existing;
  note(`+ flavor "${name}"`);
  if (!APPLY) return { id: null, name };
  return db.flavor.create({ data: { name } });
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
  //    choices when a flavor product is tapped).
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

  // 4. Pouch stock per location (all locations, so a reactivated cart is ready).
  for (const loc of locations) {
    for (const size of Object.values(POUCH_BY_SIZE)) {
      await upsertInventoryRow(loc, size, POUCH_STOCK);
    }
  }

  // 5. Recipes: size pouch + shared frozen packs + house powder where known.
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
