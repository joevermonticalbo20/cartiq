// Normalize the fries catalog into one product per FLAVOR with the SIZES as
// options (Medium / Large / XL 40 / XL 50).
//
// Why: the vendor saw 32 flat tiles ("BBQ Fries - Medium", "BBQ Fries - Large",
// ...) plus 3 dips in the POS grid. The same order exists in two shapes: one
// product per flavor with sizes as options (what the POS wants) and one product
// per size (what the grid was showing). This script creates the first shape and
// archives the second.
//
// It is data-driven: every amount, price and pouch mapping is READ from the
// existing flat products, never typed in. Only the powder amount is corrected,
// using the median of the group (two rows said 1 kg instead of 15 g).
//
// Usage (from api/):
//   node scripts/normalize_fries_catalog.mjs            # dry run, prints the plan
//   node scripts/normalize_fries_catalog.mjs --apply    # writes
//   node scripts/normalize_fries_catalog.mjs --verify   # checks the end state
//   node scripts/normalize_fries_catalog.mjs --revert   # undo (archive parents, unarchive flats)
//
// The script is idempotent: running it twice changes nothing the second time.
import "dotenv/config";
import { db } from "../src/firestore.js";

const APPLY = process.argv.includes("--apply");
const VERIFY = process.argv.includes("--verify");
const REVERT = process.argv.includes("--revert");

// The four sizes, in menu order. The label is matched against the flat product
// name suffix ("BBQ Fries - XL 40" -> "XL 40").
const SIZES = ["Medium", "Large", "XL 40", "XL 50"];
const SIZE_RE = /^(.*) - (Medium|Large|XL 40|XL 50)$/;

const median = (nums) => {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

function rowsFor(maps, productName) {
  return maps.filter((m) => m.productName === productName);
}

/** The ingredient row that names a pouch (Pouch Medium / Pouch Large / Pouch XL). */
function pouchRow(rows) {
  return rows.find((r) => String(r.itemName ?? "").trim().startsWith("Pouch")) ?? null;
}
/** The seasoning powder row (… Powder). */
function powderRow(rows) {
  return rows.find((r) => String(r.itemName ?? "").trim().endsWith("Powder")) ?? null;
}
/** The frozen packs row. */
function packsRow(rows) {
  return rows.find((r) => String(r.itemName ?? "").trim() === "Fries (frozen packs)") ?? null;
}

async function main() {
  const products = await db.product.findMany();
  const maps = await db.ingredientMap.findMany();
  const flavors = await db.flavor.findMany();

  const flats = products
    .map((p) => ({ p, m: SIZE_RE.exec(p.name ?? "") }))
    .filter((x) => x.m && (x.p.category ?? "") === "Fries")
    .map((x) => ({ product: x.p, flavorName: x.m[1].trim(), size: x.m[2].trim() }));

  // group by flavor name ("BBQ Fries")
  const groups = new Map();
  for (const flat of flats) {
    if (!groups.has(flat.flavorName)) groups.set(flat.flavorName, []);
    groups.get(flat.flavorName).push(flat);
  }

  const sizeFlavorByName = new Map(flavors.map((f) => [f.name, f]));
  const plan = [];

  for (const [flavorName, items] of [...groups.entries()].sort()) {
    const bySize = new Map(items.map((i) => [i.size, i]));
    const powderAmounts = items
      .map((i) => powderRow(rowsFor(maps, i.product.name))?.amountPerUnit)
      .filter((a) => typeof a === "number");
    // The correct powder amount is the group's median: a couple of rows said
    // 1 kg (a typo) while the rest say 15 g.
    const powderAmount = median(powderAmounts);
    const powderName =
      powderRow(rowsFor(maps, items[0].product.name))?.itemName ?? null;
    const packsAmount =
      packsRow(rowsFor(maps, items[0].product.name))?.amountPerUnit ?? 0.05;

    const sizes = SIZES.filter((s) => bySize.has(s)).map((size) => {
      const flat = bySize.get(size);
      const rows = rowsFor(maps, flat.product.name);
      const pouch = pouchRow(rows);
      return {
        size,
        price: Number(flat.product.basePrice) || 0,
        pouchItem: pouch?.itemName ?? null,
        pouchAmount: pouch?.amountPerUnit ?? 1,
        powderItem: powderRow(rows)?.itemName ?? powderName,
        powderAmount,
        sourceProduct: flat.product.name,
      };
    });

    const missingFlavorDocs = sizes
      .map((s) => s.size)
      .filter((s) => !sizeFlavorByName.has(s));

    const badPowderRows = items
      .map((i) => ({ product: i.product.name, amount: powderRow(rowsFor(maps, i.product.name))?.amountPerUnit }))
      .filter((r) => typeof r.amount === "number" && r.amount !== powderAmount);

    plan.push({
      flavorName,
      basePrice: Math.min(...sizes.map((s) => s.price)),
      sizes,
      powderAmount,
      powderName,
      packsAmount,
      missingFlavorDocs,
      badPowderRows,
      existingParent: products.find(
        (p) => p.name === flavorName && (p.flavorIds ?? []).length > 0
      ) ?? null,
    });
  }

  console.log(`fries groups: ${plan.length}`);
  console.log(`flat fries products: ${flats.length}`);

  if (VERIFY) {
    let ok = true;
    for (const g of plan) {
      const parent = products.find((p) => p.name === g.flavorName);
      const parentRows = rowsFor(maps, g.flavorName);
      const hasAllSizes = g.sizes.every((s) =>
        parentRows.some((r) => r.flavor === s.size)
      );
      // The base rows (flavor "") must exist exactly ONCE each: the deduction
      // sums every matching row, so a duplicate would multiply the amount.
      const baseKeys = parentRows
        .filter((r) => (r.flavor ?? "") === "")
        .map((r) => r.itemName);
      const baseUnique = new Set(baseKeys);
      const noDupes = baseKeys.length === baseUnique.size;
      const flatsArchived = g.sizes.every(
        (s) => bySizeOf(products, s.sourceProduct)?.active === false
      );
      const okParent =
        parent &&
        (parent.flavorIds ?? []).length === g.sizes.length &&
        parent.active !== false;
      const line = `${g.flavorName}: parent=${okParent ? "ok" : "MISSING"} sizes=${hasAllSizes ? "ok" : "INCOMPLETE"} baseRows=${noDupes ? "ok" : "DUPLICATED"} flatsArchived=${flatsArchived ? "ok" : "NO"}`;
      console.log(`  ${line}`);
      if (!okParent || !hasAllSizes || !noDupes || !flatsArchived) ok = false;
    }
    console.log(ok ? "\nVERIFY OK" : "\nVERIFY FAILED");
    process.exit(ok ? 0 : 1);
  }

  if (REVERT) {
    if (!APPLY) {
      console.log("\n(revert) dry run - pass --apply to write");
      return;
    }
    for (const g of plan) {
      const parent = products.find((p) => p.name === g.flavorName);
      if (parent) {
        await db.product.update({
          where: { id: parent.id },
          data: { active: false },
        });
        console.log(`  archived parent ${g.flavorName}`);
      }
      for (const s of g.sizes) {
        const flat = products.find((p) => p.name === s.sourceProduct);
        if (flat) {
          await db.product.update({
            where: { id: flat.id },
            data: { active: true },
          });
          console.log(`  restored ${s.sourceProduct}`);
        }
      }
    }
    console.log("\nreverted");
    return;
  }

  console.log("\n--- plan ---");
  for (const g of plan) {
    console.log(`\n${g.flavorName}  base=${g.basePrice}  powder=${g.powderName}@${g.powderAmount}  packs=${g.packsAmount}`);
    for (const s of g.sizes) {
      console.log(
        `   ${s.size.padEnd(8)} price=${String(s.price).padStart(3)}  pouch=${s.pouchItem}@${s.pouchAmount}  <- ${s.sourceProduct}`
      );
    }
    if (g.missingFlavorDocs.length) {
      console.log(`   !! missing size flavor docs: ${g.missingFlavorDocs.join(", ")}`);
    }
    if (g.badPowderRows.length) {
      console.log(
        `   !! powder typos to fix: ${g.badPowderRows
          .map((r) => `${r.product}=${r.amount}`)
          .join(", ")} -> ${g.powderAmount}`
      );
    }
    console.log(
      `   parent exists: ${g.existingParent ? "yes (will be updated)" : "no (will be created)"}`
    );
  }

  if (!APPLY) {
    console.log("\ndry run - pass --apply to write");
    return;
  }

  console.log("\n--- applying ---");
  for (const g of plan) {
    if (g.missingFlavorDocs.length) {
      console.log(`  SKIP ${g.flavorName}: missing size flavor docs`);
      continue;
    }

    // 1. Fix the powder typos on the flat products (a 1 kg row would burn the
    //    whole powder stock in one sale).
    for (const s of g.sizes) {
      for (const row of rowsFor(maps, s.sourceProduct)) {
        const isPowder = String(row.itemName ?? "").trim().endsWith("Powder");
        if (isPowder && row.amountPerUnit !== g.powderAmount) {
          await db.ingredientMap.update({
            where: { id: row.id },
            data: { amountPerUnit: g.powderAmount },
          });
          console.log(
            `  fixed powder ${s.sourceProduct}: ${row.itemName} ${row.amountPerUnit} -> ${g.powderAmount}`
          );
        }
      }
    }

    // 2. Create or update the parent product.
    const flavorIds = g.sizes
      .map((s) => sizeFlavorByName.get(s.size)?.id)
      .filter((id) => Number.isInteger(id));
    const flavorPrices = {};
    for (const s of g.sizes) {
      if (s.price !== g.basePrice) flavorPrices[s.size] = s.price;
    }
    const parentData = {
      name: g.flavorName,
      category: "Fries",
      basePrice: g.basePrice,
      flavorIds,
      flavorPrices,
      active: true,
    };
    let parent = g.existingParent;
    if (parent) {
      await db.product.update({ where: { id: parent.id }, data: parentData });
      console.log(`  updated parent ${g.flavorName} (id ${parent.id})`);
    } else {
      parent = await db.product.create({ data: parentData });
      console.log(`  created parent ${g.flavorName} (id ${parent.id})`);
    }

    // 3. The parent's recipe rows: one pouch row per size + ONE shared base
    //    row for the powder and ONE for the frozen packs.
    //
    //    The base rows carry flavor "" (they apply to every size). They must
    //    exist exactly ONCE: the deduction adds every matching row, so four
    //    copies of "powder 0.015" would deduct 60 g per serving instead of 15 g.
    const existingParentRows = rowsFor(maps, g.flavorName);
    const wantRows = [];
    for (const s of g.sizes) {
      if (s.pouchItem) {
        wantRows.push({
          flavor: s.size,
          itemName: s.pouchItem,
          amountPerUnit: s.pouchAmount,
        });
      }
    }
    if (g.powderName) {
      wantRows.push({
        flavor: "",
        itemName: g.powderName,
        amountPerUnit: g.powderAmount,
      });
    }
    wantRows.push({
      flavor: "",
      itemName: "Fries (frozen packs)",
      amountPerUnit: g.packsAmount,
    });

    for (const row of wantRows) {
      const hit = existingParentRows.find(
        (r) => (r.flavor ?? "") === row.flavor && r.itemName === row.itemName
      );
      if (!hit) {
        await db.ingredientMap.create({
          data: {
            productName: g.flavorName,
            flavor: row.flavor,
            itemName: row.itemName,
            amountPerUnit: row.amountPerUnit,
          },
        });
        console.log(
          `    + recipe ${g.flavorName} [${row.flavor || "-"}] ${row.itemName}=${row.amountPerUnit}`
        );
      } else if (hit.amountPerUnit !== row.amountPerUnit) {
        await db.ingredientMap.update({
          where: { id: hit.id },
          data: { amountPerUnit: row.amountPerUnit },
        });
        console.log(
          `    ~ recipe ${g.flavorName} [${row.flavor || "-"}] ${row.itemName} ${hit.amountPerUnit} -> ${row.amountPerUnit}`
        );
      }
    }

    // 3b. Remove duplicate base rows (the same flavor "" + item twice): the
    //     deduction sums every matching row.
    const seenBase = new Set();
    for (const row of rowsFor(maps, g.flavorName)) {
      const key = `${row.flavor ?? ""}|${row.itemName}`;
      if (!seenBase.has(key)) {
        seenBase.add(key);
        continue;
      }
      await db.ingredientMap.delete({ where: { id: row.id } });
      console.log(
        `    - duplicate recipe ${g.flavorName} [${row.flavor || "-"}] ${row.itemName}`
      );
    }

    // 4. Archive the flat duplicates (history stays; the POS hides them).
    for (const s of g.sizes) {
      const flat = products.find((p) => p.name === s.sourceProduct);
      if (flat && flat.active !== false) {
        await db.product.update({
          where: { id: flat.id },
          data: { active: false },
        });
        console.log(`  archived ${s.sourceProduct}`);
      }
    }
  }

  console.log("\ndone");
}

function bySizeOf(products, name) {
  return products.find((p) => p.name === name) ?? null;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
