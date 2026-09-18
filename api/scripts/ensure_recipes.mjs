#!/usr/bin/env node
// Ensure every product-flavor follows the house recipe convention
// (src/services/recipe_defaults.js): 1 pouch + 0.05 frozen packs per serving
// (generic rows) + 15 g powder per flavored serving.
//
//   node scripts/ensure_recipes.mjs            # dry run: prints the plan
//   node scripts/ensure_recipes.mjs --apply    # writes missing rows + aligns amounts
//
// Works against the emulator (FIRESTORE_EMULATOR_HOST) or real Firestore
// (GOOGLE_APPLICATION_CREDENTIALS + FIREBASE_PROJECT_ID). Recipes are global
// (keyed by productName + flavor), so one run covers EVERY cart; per-cart
// stock-row coverage is reported (owner adds stock intentionally — the
// script never invents quantities).
import "dotenv/config";
import { db } from "../src/firestore.js";
import {
  genericRecipeRows,
  flavorRecipeRows,
  POWDER_KG_PER_UNIT,
} from "../src/services/recipe_defaults.js";

const APPLY = process.argv.includes("--apply");

async function upsertRow(productName, flavor, itemName, amount, counters) {
  const rows = await db.ingredientMaps.findMany({ where: { productName, flavor, itemName } });
  if (rows[0]) {
    if (Number(rows[0].amountPerUnit) !== amount) {
      counters.toLog.push(`ALIGN  ${productName} / ${flavor || "(base)"} / ${itemName}: ${rows[0].amountPerUnit} -> ${amount}`);
      if (APPLY) {
        await db.collection("ingredientMaps").doc(String(rows[0].id)).update({ amountPerUnit: amount });
        counters.aligned++;
      }
    }
    return;
  }
  counters.toLog.push(`ADD    ${productName} / ${flavor || "(base)"} / ${itemName} x${amount}`);
  if (APPLY) {
    await db.ingredientMaps.create({ data: { productName, flavor, itemName, amountPerUnit: amount } });
    counters.added++;
  }
}

async function main() {
  const counters = { added: 0, aligned: 0, toLog: [], unknownFlavors: new Set(), cartGaps: [] };
  const [products, flavors, maps, locations] = await Promise.all([
    db.product.findMany({ include: { flavors: true } }),
    db.flavor.findMany(),
    db.ingredientMap.findMany(),
    db.location.findMany(),
  ]);
  const flavorNameById = new Map(flavors.map((f) => [Number(f.id), f.name]));
  const existingKeys = new Set(maps.map((m) => JSON.stringify([m.productName, m.flavor ?? "", m.itemName])));

  for (const p of products) {
    const linkedIds = (p.flavorIds ?? (p.flavors ?? []).map((f) => f.id)).map(Number);
    const linkedNames = linkedIds.map((id) => flavorNameById.get(id)).filter(Boolean);
    // Generic rows for the product itself.
    for (const r of genericRecipeRows()) {
      if (!existingKeys.has(JSON.stringify([p.name, "", r.itemName]))) {
        await upsertRow(p.name, "", r.itemName, r.amountPerUnit, counters);
        existingKeys.add(JSON.stringify([p.name, "", r.itemName]));
      } else {
        const row = maps.find(
          (m) => m.productName === p.name && (m.flavor ?? "") === "" && m.itemName === r.itemName
        );
        if (row && Number(row.amountPerUnit) !== r.amountPerUnit) {
          await upsertRow(p.name, "", r.itemName, r.amountPerUnit, counters);
        }
      }
    }
    // One powder row per linked flavor (known flavors only).
    for (const fname of linkedNames) {
      const { rows, unknownFlavor } = flavorRecipeRows(fname);
      if (unknownFlavor) {
        counters.unknownFlavors.add(`${p.name} / ${fname}`);
        continue;
      }
      for (const r of rows) {
        const key = JSON.stringify([p.name, fname, r.itemName]);
        if (!existingKeys.has(key)) {
          await upsertRow(p.name, fname, r.itemName, r.amountPerUnit, counters);
          existingKeys.add(key);
        } else {
          const row = maps.find(
            (m) => m.productName === p.name && m.flavor === fname && m.itemName === r.itemName
          );
          if (row && Number(row.amountPerUnit) !== r.amountPerUnit) {
            await upsertRow(p.name, fname, r.itemName, r.amountPerUnit, counters);
          }
        }
      }
    }
  }

  // Per-cart stock-row coverage: every recipe item should exist as a stock
  // row in every ACTIVE cart, or sales there warn instead of deducting.
  const needed = new Set(maps.map((m) => String(m.itemName ?? "").trim()).filter(Boolean));
  for (const r of counters.toLog) {
    const m = r.match(/\/ ([^/]+) x[\d.]+$/);
    if (m) needed.add(m[1]);
  }
  const invRows = await db.inventoryItem.findMany();
  const byLoc = new Map();
  for (const inv of invRows) {
    if (!byLoc.has(inv.locationId)) byLoc.set(inv.locationId, new Set());
    byLoc.get(inv.locationId).add(String(inv.name ?? "").trim());
  }
  for (const loc of locations.filter((l) => l.status !== "INACTIVE")) {
    const have = byLoc.get(loc.id) ?? new Set();
    const missing = [...needed].filter((n) => !have.has(n));
    if (missing.length > 0) counters.cartGaps.push(`${loc.code}: missing stock rows for ${missing.join(", ")}`);
  }

  console.log(`Mode: ${APPLY ? "APPLY (writing)" : "DRY RUN (no writes — add --apply to write)"}`);
  console.log(`Products scanned: ${products.length}`);
  for (const line of counters.toLog) console.log(`  ${line}`);
  console.log(`Recipe rows added: ${counters.added}, amounts aligned to 15 g convention: ${counters.aligned}`);
  if (counters.unknownFlavors.size > 0) {
    console.log("Flavors with no powder mapping (add recipes in Products -> Edit):");
    for (const f of counters.unknownFlavors) console.log(`  ?? ${f} (default ${POWDER_KG_PER_UNIT} kg/serving not applied)`);
  }
  if (counters.cartGaps.length > 0) {
    console.log("Carts missing stock rows (add stock in Inventory so sales deduct):");
    for (const g of counters.cartGaps) console.log(`  !! ${g}`);
  } else {
    console.log("Every ACTIVE cart stocks every recipe item.");
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
