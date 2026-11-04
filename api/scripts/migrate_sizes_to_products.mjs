// One-off, irreversible catalog migration: "size variants" become flat products.
//
// Every ACTIVE product that links variant flavors gets one product per linked
// variant:
//
//   "Cheese Fries" (Medium/Large/XL 40/XL 50)
//     -> "Cheese Fries - Medium"  (₱20, = basePrice)
//     -> "Cheese Fries - Large"   (₱30, = flavorPrices.Large)
//     -> "Cheese Fries - XL 40"   (₱40)
//     -> "Cheese Fries - XL 50"   (₱50)
//
// Recipe rows are moved along so deduction keeps working with NO flavor on the
// order line (matcher keys on (productName, "")):
//   - (parent, variantName) -> (parent - variantName, "")   amountPerUnit kept
//   - (parent, "")          -> duplicated into EVERY new product ("")
// Parent products are ARCHIVED (active:false), never deleted, so the migration
// is reversible.
//
//   node scripts/migrate_sizes_to_products.mjs            # dry-run (read-only)
//   node scripts/migrate_sizes_to_products.mjs --apply    # writes (needs backup)
//
// Refuses --apply without today's backup from scripts/backup_firestore.mjs.
import "dotenv/config";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { initializeApp, getApps, applicationDefault, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const todayDir = join(root, ".backups", new Date().toISOString().slice(0, 10));
const apply = process.argv.includes("--apply");

if (apply && !existsSync(join(todayDir, "_summary.json"))) {
  console.error(`Refusing: no backup for today (${todayDir}). Run backup_firestore.mjs first.`);
  process.exit(1);
}
if (apply) {
  const backup = JSON.parse(readFileSync(join(todayDir, "_summary.json"), "utf8"));
  console.log(`Backup verified: ${todayDir} (${backup.collections.length} collections)`);
}

if (getApps().length === 0) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)), projectId: process.env.FIREBASE_PROJECT_ID || "cartiq-8e46f" });
  } else {
    initializeApp({ credential: applicationDefault(), projectId: process.env.FIREBASE_PROJECT_ID || "cartiq-8e46f" });
  }
}
const fs = getFirestore();

const products = (await fs.collection("products").get()).docs.map((d) => d.data());
const flavors = (await fs.collection("flavors").get()).docs.map((d) => d.data());
const maps = (await fs.collection("ingredientMaps").get()).docs.map((d) => d.data());

const sizeFlavors = new Set(
  flavors.filter((f) => /^(medium|large|xl\s*\d*|xl)$/i.test(String(f.name).trim())).map((f) => f.name),
);

const planned = []; // { parent, flavor, newName, newPrice }
for (const p of products) {
  if (p.active === false) continue;
  const ids = Array.isArray(p.flavorIds) ? p.flavorIds.map(Number) : [];
  if (ids.length === 0) continue;
  const linked = flavors.filter((f) => ids.includes(Number(f.id)));
  for (const f of linked) {
    const newName = `${p.name} - ${f.name}`;
    const price = Number(p.flavorPrices?.[f.name] ?? p.basePrice);
    planned.push({ parent: p, flavor: f, newName, newPrice: price, isSize: sizeFlavors.has(f.name) });
  }
}

console.log(`\nActive products with variants: ${new Set(planned.map((x) => x.parent.id)).size}`);
console.log(`New products to create:      ${planned.length}`);
console.log(`Size-backed variants:        ${planned.filter((x) => x.isSize).length}`);
console.log("\nPlan:");
for (const x of planned) {
  console.log(`  ${JSON.stringify(x.parent.name)} + ${x.flavor.name}  ->  ${JSON.stringify(x.newName)}  @ ₱${x.newPrice}`);
}

// Idempotency guard: abort BEFORE any write on a name clash.
const existingNames = new Set(products.map((p) => String(p.name).toLowerCase()));
const clash = planned.filter((x) => existingNames.has(x.newName.toLowerCase()));
if (clash.length) {
  console.error(`\nRefusing to run: ${clash.length} planned name(s) already exist (not idempotent). Nothing was written.`);
  process.exit(1);
}

const genericMaps = maps.filter((m) => !m.flavor || m.flavor === "");
const variantMaps = maps.filter((m) => m.flavor && m.flavor !== "");
const newMapCount =
  genericMaps.filter((m) => planned.some((x) => x.parent.name === m.productName)).length *
    (planned.length / new Set(planned.map((x) => x.parent.name)).size) +
  variantMaps.filter((m) => planned.some((x) => x.parent.name === m.productName && x.flavor.name === m.flavor)).length;
console.log(`\nGeneric recipe rows to duplicate per new product: ${genericMaps.filter((m) => planned.some((x) => x.parent.name === m.productName)).length}`);
console.log(`Variant recipe rows to move:                     ${variantMaps.filter((m) => planned.some((x) => x.parent.name === m.productName && x.flavor.name === m.flavor)).length}`);
console.log(`New ingredientMaps docs total:                    ${newMapCount}`);

if (!apply) {
  console.log("\nDRY RUN - nothing written. Re-run with --apply to execute.");
  process.exit(0);
}

// ---- apply ---------------------------------------------------------------
const counterDoc = await fs.collection("_counters").doc("products").get();
let nextId = Number(counterDoc.data()?.next ?? 1);
console.log(`\nAllocating products from id ${nextId} ...`);

const batch = fs.batch();
const allocations = [];
for (const x of planned) {
  const id = nextId++;
  allocations.push({ ...x, id });
  const doc = {
    id,
    name: x.newName,
    category: x.parent.category ?? "Fries",
    basePrice: x.newPrice,
    active: true,
    ...(x.parent.imageUrl ? { imageUrl: x.parent.imageUrl } : {}),
    ...(x.parent.isBestSeller === true ? { isBestSeller: true } : {}),
    createdAt: new Date().toISOString(),
  };
  batch.set(fs.collection("products").doc(String(id)), doc);
}
batch.set(fs.collection("_counters").doc("products"), { next: nextId }, { merge: true });
// Archive parents (keep everything else — restore is one field flip).
for (const x of planned) batch.set(fs.collection("products").doc(String(x.parent.id)), { active: false }, { merge: true });
await batch.commit();
console.log(`Created ${allocations.length} products (ids ${allocations[0].id}-${allocations[allocations.length - 1].id}); archived ${new Set(planned.map((x) => x.parent.id)).size} parents.`);

const recipeBatches = [];
let current = fs.batch();
let pending = 0;
const push = (ref) => { current.create(ref.col.doc(ref.id), ref.data) ?? null; };
const queue = (col, data) => {
  const docRef = fs.collection(col).doc();
  current.create(docRef, data);
  pending += 1;
  if (pending >= 400) { recipeBatches.push(current); current = fs.batch(); pending = 0; }
};
const byName = new Map(allocations.map((x) => [`${x.parent.name} / ${x.flavor.name}`, x]));
for (const x of planned) {
  for (const m of genericMaps.filter((m) => m.productName === x.parent.name)) {
    queue("ingredientMaps", { productName: x.newName, flavor: "", itemName: m.itemName, amountPerUnit: m.amountPerUnit });
  }
  for (const m of variantMaps.filter((m) => m.productName === x.parent.name && m.flavor === x.flavor.name)) {
    queue("ingredientMaps", { productName: x.newName, flavor: "", itemName: m.itemName, amountPerUnit: m.amountPerUnit });
  }
}
void push;
recipeBatches.push(current);
for (const b of recipeBatches) await b.commit();
console.log(`Created recipe rows in ${recipeBatches.length} batch(es).`);

// Bump the POS catalog version so every app refetches the flat catalog.
const meta = await fs.collection("catalogMeta").doc("catalog").get();
const cur = Number(meta.exists ? meta.data()?.version : 0);
await fs.collection("catalogMeta").doc("catalog").set(
  { version: cur + 1, updatedAt: new Date().toISOString() },
  { merge: true },
);
console.log(`Catalog version bumped ${cur} -> ${cur + 1}`);

// Verify: counts and a sample doc.
const finalProducts = (await fs.collection("products").get()).size;
const finalMaps = (await fs.collection("ingredientMaps").get()).size;
const sample = await fs.collection("products").doc(String(allocations[0].id)).get();
console.log(`\nProducts total: ${finalProducts}  |  Recipe rows total: ${finalMaps}`);
console.log("Sample new product:", JSON.stringify(sample.data()));
console.log("\nMigration complete. Parents are archived (active:false) and fully restorable.");
