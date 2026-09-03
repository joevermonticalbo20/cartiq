import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Documented development device tokens (bcrypt-hashed in the database).
// Rotate these before any deployment beyond localhost.
const DEVICE_TOKENS = {
  "esp32-cart-01": "dev-CART-01-potafries",
  "esp32-cart-02": "dev-CART-02-potafries",
  "esp32-cart-03": "dev-CART-03-potafries",
};

async function main() {
  const hash = (pw) => bcrypt.hashSync(pw, 10);

  // Locations
  const cart01 = await prisma.location.upsert({
    where: { code: "CART-01" },
    update: {},
    create: { code: "CART-01", name: "LSPU Main Canteen", address: "LSPU Main Campus, Sta. Cruz, Laguna" },
  });
  const cart02 = await prisma.location.upsert({
    where: { code: "CART-02" },
    update: {},
    create: { code: "CART-02", name: "Guevarra NHS Canteen", address: "Guevarra National High School, Sta. Cruz, Laguna" },
  });
  const cart03 = await prisma.location.upsert({
    where: { code: "CART-03" },
    update: {},
    create: { code: "CART-03", name: "Central Elementary School Canteen", address: "Central Elementary School, Sta. Cruz, Laguna" },
  });

  // Users
  const users = [
    { name: "John Louie Bornillo", username: "owner", password: "owner123", role: "OWNER", locationId: null, rfidUid: null },
    { name: "Stall Staff 1", username: "staff01", password: "staff123", role: "STAFF", locationId: cart01.id, rfidUid: "04A2B3C4" },
    { name: "Stall Staff 2", username: "staff02", password: "staff123", role: "STAFF", locationId: cart02.id, rfidUid: "05B3C4D5" },
    { name: "Stall Staff 3", username: "staff03", password: "staff123", role: "STAFF", locationId: cart03.id, rfidUid: "06C4D5E6" },
  ];
  for (const u of users) {
    const { password, ...userData } = u;
    await prisma.user.upsert({
      where: { username: userData.username },
      update: { name: userData.name, role: userData.role, locationId: userData.locationId, rfidUid: userData.rfidUid },
      create: { ...userData, passwordHash: hash(password) },
    });
  }

  // ESP32 devices (one node per cart)
  for (const [deviceId, token] of Object.entries(DEVICE_TOKENS)) {
    const code = deviceId.replace("esp32-", "").toUpperCase();
    const location = [cart01, cart02, cart03].find((l) => l.code === code);
    await prisma.device.upsert({
      where: { deviceId },
      update: { tokenHash: hash(token), active: true },
      create: {
        deviceId,
        locationId: location.id,
        tokenHash: hash(token),
      },
    });
  }

  // Products + flavors
  const cheese = await prisma.flavor.upsert({ where: { name: "Cheese" }, update: {}, create: { name: "Cheese" } });
  const sourCream = await prisma.flavor.upsert({ where: { name: "Sour Cream" }, update: {}, create: { name: "Sour Cream" } });
  const bbq = await prisma.flavor.upsert({ where: { name: "BBQ" }, update: {}, create: { name: "BBQ" } });

  const fries = await prisma.product.upsert({
    where: { name: "Flavored Fries" },
    update: {},
    create: {
      name: "Flavored Fries",
      category: "Fries",
      basePrice: 40,
      flavors: { connect: [cheese, sourCream, bbq].map((f) => ({ id: f.id })) },
    },
  });

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
      await prisma.inventoryItem.upsert({
        where: { locationId_name: { locationId: loc.id, name: item.name } },
        update: { stock: item.stock, threshold: item.threshold },
        create: { ...item, locationId: loc.id },
      });
    }
  }

  // Supplier
  await prisma.supplier.upsert({
    where: { name: "Sta. Cruz Grocery Supply" },
    update: {},
    create: { name: "Sta. Cruz Grocery Supply", contact: "0917-000-0000", notes: "Powder, packs, pouches - same-day delivery" },
  });

  // Recipe maps for automatic inventory deduction per unit sold
  const recipes = [
    { productName: fries.name, flavor: "", itemName: "Pouches", amountPerUnit: 1 },
    { productName: fries.name, flavor: "", itemName: "Fries (frozen packs)", amountPerUnit: 0.05 },
    { productName: fries.name, flavor: "Cheese", itemName: "Cheese Powder", amountPerUnit: 0.03 },
    { productName: fries.name, flavor: "Sour Cream", itemName: "Sour Cream Powder", amountPerUnit: 0.03 },
    { productName: fries.name, flavor: "BBQ", itemName: "BBQ Powder", amountPerUnit: 0.03 },
  ];
  for (const r of recipes) {
    await prisma.ingredientMap.upsert({
      where: {
        productName_flavor_itemName: {
          productName: r.productName,
          flavor: r.flavor,
          itemName: r.itemName,
        },
      },
      update: { amountPerUnit: r.amountPerUnit },
      create: r,
    });
  }

  console.log("Seed complete.");
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
    await prisma.$disconnect();
  });
