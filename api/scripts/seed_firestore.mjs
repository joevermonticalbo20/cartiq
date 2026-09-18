// CartIQ Firestore seed — exact data replica of prisma/seed.js.
// Same logins, RFIDs, locations, products, recipes and device tokens.
// Works against the emulator (FIRESTORE_EMULATOR_HOST) or real Firestore
// (GOOGLE_APPLICATION_CREDENTIALS + FIREBASE_PROJECT_ID). Re-runnable.
import "dotenv/config";
import bcrypt from "bcryptjs";
import { db } from "../src/firestore.js";

// Documented development device tokens (bcrypt-hashed in the database).
// Rotate these before any deployment beyond localhost.
const DEVICE_TOKENS = {
  "esp32-cart-01": "dev-CART-01-potafries",
  "esp32-cart-02": "dev-CART-02-potafries",
  "esp32-cart-03": "dev-CART-03-potafries",
};

async function upsertLocation(code, data) {
  const existing = await db.locations.findUnique({ where: { code } });
  if (existing) return existing;
  return db.locations.create({ data: { code, ...data } });
}

async function main() {
  const hash = (pw) => bcrypt.hashSync(pw, 10);

  // Locations
  const cart01 = await upsertLocation("CART-01", { name: "LSPU Main Canteen", address: "LSPU Main Campus, Sta. Cruz, Laguna" });
  const cart02 = await upsertLocation("CART-02", { name: "Guevarra NHS Canteen", address: "Guevarra National High School, Sta. Cruz, Laguna" });
  const cart03 = await upsertLocation("CART-03", { name: "Central Elementary School Canteen", address: "Central Elementary School, Sta. Cruz, Laguna" });

  // Users (upsert keeps the existing passwordHash, like the Prisma seed)
  const users = [
    { name: "John Louie Bornillo", username: "owner", password: "owner123", role: "OWNER", locationId: null, rfidUid: null },
    { name: "Stall Staff 1", username: "staff01", password: "staff123", role: "STAFF", locationId: cart01.id, rfidUid: "04A2B3C4" },
    { name: "Stall Staff 2", username: "staff02", password: "staff123", role: "STAFF", locationId: cart02.id, rfidUid: "05B3C4D5" },
    { name: "Stall Staff 3", username: "staff03", password: "staff123", role: "STAFF", locationId: cart03.id, rfidUid: "06C4D5E6" },
  ];
  for (const u of users) {
    const { password, ...userData } = u;
    const existing = await db.users.findUnique({ where: { username: userData.username } });
    if (existing) {
      await db.users.update({
        where: { id: existing.id },
        data: { name: userData.name, role: userData.role, locationId: userData.locationId, rfidUid: userData.rfidUid },
      });
    } else {
      await db.users.create({ data: { ...userData, passwordHash: hash(password) } });
    }
  }

  // ESP32 devices (one node per cart)
  for (const [deviceId, token] of Object.entries(DEVICE_TOKENS)) {
    const code = deviceId.replace("esp32-", "").toUpperCase();
    const location = [cart01, cart02, cart03].find((l) => l.code === code);
    const existing = await db.devices.findUnique({ where: { deviceId } });
    if (existing) {
      await db.devices.update({ where: { id: existing.id }, data: { tokenHash: hash(token), active: true } });
    } else {
      await db.devices.create({ data: { deviceId, locationId: location.id, tokenHash: hash(token) } });
    }
  }

  // Products + flavors
  async function upsertFlavor(name) {
    const existing = await db.flavors.findUnique({ where: { name } });
    return existing ?? db.flavors.create({ data: { name } });
  }
  const cheese = await upsertFlavor("Cheese");
  const sourCream = await upsertFlavor("Sour Cream");
  const bbq = await upsertFlavor("BBQ");

  let fries = await db.products.findUnique({ where: { name: "Flavored Fries" } });
  if (!fries) {
    fries = await db.products.create({
      data: {
        name: "Flavored Fries",
        category: "Fries",
        basePrice: 40,
        flavorIds: [cheese, sourCream, bbq].map((f) => f.id),
      },
    });
  }

  // Inventory per cart (LPG tank + cheese powder are the sensor-monitored items)
  const inventoryTemplate = [
    { name: "LPG Tank", unit: "kg", stock: 11.0, threshold: 2.5, source: "SENSOR" },
    { name: "Cheese Powder", unit: "kg", stock: 3.0, threshold: 1.0, source: "SENSOR" },
    { name: "Sour Cream Powder", unit: "kg", stock: 2.0, threshold: 1.0, source: "MANUAL" },
    { name: "BBQ Powder", unit: "kg", stock: 2.0, threshold: 1.0, source: "MANUAL" },
    { name: "Fries (frozen packs)", unit: "packs", stock: 12, threshold: 4, source: "MANUAL" },
    { name: "Pouches", unit: "pcs", stock: 150, threshold: 50, source: "MANUAL" },
  ];
  for (const loc of [cart01, cart02, cart03]) {
    for (const item of inventoryTemplate) {
      const rows = await db.inventoryItems.findMany({
        where: { locationId: loc.id, name: item.name },
      });
      if (rows[0]) {
        await db.inventoryItems.update({
          where: { id: rows[0].id },
          data: { stock: item.stock, threshold: item.threshold },
        });
      } else {
        await db.inventoryItems.create({ data: { ...item, locationId: loc.id } });
      }
    }
  }

  // Supplier
  if (!(await db.suppliers.findUnique({ where: { name: "Sta. Cruz Grocery Supply" } }))) {
    await db.suppliers.create({
      data: { name: "Sta. Cruz Grocery Supply", contact: "0917-000-0000", notes: "Powder, packs, pouches - same-day delivery" },
    });
  }

  // Recipe maps for automatic inventory deduction per unit sold.
  // Fixed demo fixture (kept stable for CI forecast suites — do NOT retune
  // here). The house convention lives in services/recipe_defaults.js and
  // scripts/ensure_recipes.mjs aligns data to it (dry-run or --apply).
  const recipes = [
    { productName: fries.name, flavor: "", itemName: "Pouches", amountPerUnit: 1 },
    { productName: fries.name, flavor: "", itemName: "Fries (frozen packs)", amountPerUnit: 0.05 },
    { productName: fries.name, flavor: "Cheese", itemName: "Cheese Powder", amountPerUnit: 0.03 },
    { productName: fries.name, flavor: "Sour Cream", itemName: "Sour Cream Powder", amountPerUnit: 0.03 },
    { productName: fries.name, flavor: "BBQ", itemName: "BBQ Powder", amountPerUnit: 0.03 },
  ];
  for (const r of recipes) {
    const rows = await db.ingredientMaps.findMany({
      where: { productName: r.productName, flavor: r.flavor, itemName: r.itemName },
    });
    if (rows[0]) {
      // Raw update (no numeric id on this model; nothing references the doc
      // id, and cache invalidation is irrelevant in this standalone process).
      await db.collection("ingredientMaps").doc(String(rows[0].id)).update({ amountPerUnit: r.amountPerUnit });
    } else {
      await db.ingredientMaps.create({ data: r });
    }
  }

  console.log("Seed complete (Firestore).");
  console.log("  Locations :", [cart01.code, cart02.code, cart03.code].join(", "));
  console.log("  Products  :", fries.name, "(Cheese / Sour Cream / BBQ)");
  console.log("  Recipes   :", recipes.length, "ingredient mappings");
  console.log("  Logins    : owner/owner123 | staff01..03/staff123");
  console.log("  RFID UIDs : staff01=04A2B3C4 | staff02=05B3C4D5 | staff03=06C4D5E6");
  console.log("  Device tokens:");
  for (const [id, token] of Object.entries(DEVICE_TOKENS)) {
    console.log(`    ${id} -> ${token}`);
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
