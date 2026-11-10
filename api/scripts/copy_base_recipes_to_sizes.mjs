// Copy a flavor parent's shared base recipe rows (powder + frozen packs) into
// every size/flavor, so each size owns its COMPLETE recipe.
//
// Why: the deduction merges flavor "" (base) rows with the sold flavor's rows
// and a flavor-specific row wins per itemName (services/inventory_rules.js).
// Copying the base rows into each size therefore changes NO deduction amount,
// but it lets the owner edit one size without touching the others.
//
// The base rows are kept as a fallback for any future size that has no copy.
//
// Usage:
//   node scripts/copy_base_recipes_to_sizes.mjs           (dry run)
//   node scripts/copy_base_recipes_to_sizes.mjs --apply
//   node scripts/copy_base_recipes_to_sizes.mjs --verify
import "dotenv/config";
import { db } from "../src/firestore.js";

const APPLY = process.argv.includes("--apply");
const VERIFY = process.argv.includes("--verify");

const rowsFor = (maps, productName) => maps.filter((m) => m.productName === productName);
const baseRowsOf = (rows) => rows.filter((r) => (r.flavor ?? "") === "");

async function main() {
  const [products, flavors, maps] = await Promise.all([
    db.product.findMany(),
    db.flavor.findMany(),
    db.ingredientMap.findMany(),
  ]);
  const flavorNameById = new Map(flavors.map((f) => [Number(f.id), String(f.name)]));

  const parents = products
    .filter((p) => (p.flavorIds ?? []).length > 0)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));

  let planned = 0;
  let parentsDone = 0;
  let missingBase = 0;
  const plan = [];

  for (const parent of parents) {
    const rows = rowsFor(maps, parent.name);
    const baseRows = baseRowsOf(rows);
    if (baseRows.length === 0) {
      missingBase += 1;
      console.log(`SKIP ${parent.name}: no base recipe rows`);
      continue;
    }
    const flavorNames = (parent.flavorIds ?? [])
      .map((id) => flavorNameById.get(Number(id)))
      .filter(Boolean);
    let parentCreates = 0;
    for (const flavor of flavorNames) {
      const specific = rows.filter((r) => r.flavor === flavor);
      const creates = baseRows.filter(
        (base) => !specific.some((r) => r.itemName === base.itemName)
      );
      // Duplicate (flavor, itemName) rows are ambiguous (the deduction takes
      // the first one). Report them instead of guessing.
      const seen = new Set();
      for (const r of specific) {
        if (seen.has(r.itemName)) {
          console.log(`  !! duplicate ${parent.name} [${flavor}] ${r.itemName}`);
        }
        seen.add(r.itemName);
      }
      if (creates.length > 0) {
        plan.push({ parent, flavor, creates });
        parentCreates += creates.length;
        planned += creates.length;
      }
      console.log(
        `  ${parent.name} [${flavor}]: ${specific.length} row(s), +${creates.length} copied`
      );
    }
    if (parentCreates > 0) parentsDone += 1;
  }

  console.log(
    `\nparents: ${parents.length}, needing copies: ${parentsDone}, rows to create: ${planned}, no base rows: ${missingBase}`
  );

  if (VERIFY) {
    let ok = true;
    for (const parent of parents) {
      const rows = rowsFor(maps, parent.name);
      const baseRows = baseRowsOf(rows);
      if (baseRows.length === 0) continue;
      const flavorNames = (parent.flavorIds ?? [])
        .map((id) => flavorNameById.get(Number(id)))
        .filter(Boolean);
      for (const flavor of flavorNames) {
        const specific = rows.filter((r) => r.flavor === flavor);
        const missing = baseRows.filter(
          (base) => !specific.some((r) => r.itemName === base.itemName)
        );
        if (missing.length > 0) {
          console.log(`  MISSING ${parent.name} [${flavor}]: ${missing.map((r) => r.itemName).join(", ")}`);
          ok = false;
        }
      }
    }
    console.log(ok ? "\nVERIFY OK - every size has a complete recipe" : "\nVERIFY FAILED");
    process.exit(ok ? 0 : 1);
  }

  if (!APPLY) {
    console.log("\ndry run - pass --apply to write");
    return;
  }

  let created = 0;
  for (const item of plan) {
    for (const base of item.creates) {
      await db.ingredientMap.create({
        data: {
          productName: item.parent.name,
          flavor: item.flavor,
          itemName: base.itemName,
          amountPerUnit: base.amountPerUnit,
        },
      });
      created += 1;
      console.log(
        `  + ${item.parent.name} [${item.flavor}] ${base.itemName}=${base.amountPerUnit}`
      );
    }
  }
  console.log(`\ncreated ${created} recipe row(s)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
