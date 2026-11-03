// Read-only: what exists in production right now (products, flavors,
// inventory rows per cart, locations). Used to plan the Pota Fries seed.
import "dotenv/config";
import { db } from "../src/firestore.js";

const [products, flavors, locations, inv, maps] = await Promise.all([
  db.product.findMany({ include: { flavors: true }, orderBy: { name: "asc" } }),
  db.flavor.findMany({ orderBy: { name: "asc" } }),
  db.location.findMany({ orderBy: { code: "asc" } }),
  db.inventoryItem.findMany({ orderBy: { name: "asc" } }),
  db.ingredientMap.findMany(),
]);

console.log("== LOCATIONS ==");
for (const l of locations) console.log(` ${l.id}  ${l.code}  ${l.name}  ${l.status ?? "ACTIVE"}`);

console.log("\n== PRODUCTS ==");
for (const p of products) {
  const fl = (p.flavors ?? []).map((f) => f.name).join(", ");
  console.log(` ${p.id}  ${p.name}  cat=${p.category}  base=${p.basePrice}  active=${p.active !== false}  prices=${JSON.stringify(p.flavorPrices ?? {})}  flavors=[${fl}]`);
}

console.log("\n== FLAVORS ==");
console.log(" " + flavors.map((f) => `${f.id}:${f.name}`).join("  |  "));

console.log("\n== INVENTORY (per location) ==");
for (const l of locations) {
  const rows = inv.filter((i) => i.locationId === l.id);
  console.log(` ${l.code}: ${rows.map((r) => `${r.name}(${r.stock}${r.unit})`).join(", ") || "-"}`);
}

console.log("\n== RECIPE MAPS ==");
for (const m of maps) console.log(` ${m.productName} / ${m.flavor || "(base)"} -> ${m.itemName} x${m.amountPerUnit}`);

await db.$disconnect();
