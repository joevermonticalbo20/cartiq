// One-off cleanup: the carts no longer run load cells, so every stock row is
// a manual count.
//
//   - deletes the leftover SENSOR rows named on the command line
//     (default: "LPG Tank")
//   - flips every remaining SENSOR row to MANUAL
//
// Run with:
//   node scripts/cleanup_sensor_inventory.mjs
//   node scripts/cleanup_sensor_inventory.mjs --delete "LPG Tank,Cheese Bin"
import "dotenv/config";
import { db } from "../src/firestore.js";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const namesToDelete = arg("--delete", "LPG Tank")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

async function main() {
  const items = await db.inventoryItems.findMany();
  const locations = await db.locations.findMany();
  const codeById = new Map(locations.map((l) => [l.id, l.code]));

  console.log(`inventory rows: ${items.length}`);
  for (const it of items) {
    console.log(
      `  ${it.id} ${it.name} @ ${codeById.get(it.locationId) ?? it.locationId} ` +
        `stock=${it.stock} ${it.unit} threshold=${it.threshold} source=${it.source}`,
    );
  }

  const maps = await db.ingredientMaps.findMany();
  const mapNames = new Set(maps.map((m) => m.itemName));

  for (const name of namesToDelete) {
    const rows = items.filter((it) => it.name === name);
    if (rows.length === 0) {
      console.log(`  skip "${name}": no such row`);
      continue;
    }
    for (const row of rows) {
      if (mapNames.has(row.name)) {
        console.log(`  skip "${row.name}" (id ${row.id}): used by a recipe row`);
        continue;
      }
      await db.inventoryItems.delete({ where: { id: row.id } });
      console.log(`  deleted "${row.name}" (id ${row.id})`);
    }
  }

  const stillSensor = (await db.inventoryItems.findMany()).filter(
    (it) => it.source === "SENSOR",
  );
  for (const row of stillSensor) {
    await db.inventoryItems.update({
      where: { id: row.id },
      data: { source: "MANUAL" },
    });
    console.log(`  set "${row.name}" (id ${row.id}) to MANUAL`);
  }

  const after = await db.inventoryItems.findMany();
  console.log(`\nremaining rows: ${after.length}`);
  for (const it of after) {
    console.log(
      `  ${it.id} ${it.name} @ ${codeById.get(it.locationId) ?? it.locationId} ` +
        `stock=${it.stock} ${it.unit} threshold=${it.threshold} source=${it.source}`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
