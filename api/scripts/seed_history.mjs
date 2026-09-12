#!/usr/bin/env node
// Generates ~21 days of realistic demo sales history so the descriptive
// dashboards and the predictive forecasts have data to work with.
// Inserts bypass order/ingredient business rules on purpose (raw history).
//
//   node scripts/seed_history.mjs [days] [--clean]     (default 21)
//
//   --clean wipes previously seeded history (orders with clientRef LIKE
//   'hist-%') first, so re-runs don't duplicate the demo dataset.
//
// Firestore port: identical dataset shape (same clientRef format, totals,
// items, dates). Order items are embedded in the order doc with allocated
// numeric ids, matching API-created orders field-for-field.
import "dotenv/config";
import { db } from "../src/firestore.js";

const DAYS = Number(process.argv[2]) || 21;
const CLEAN = process.argv.includes("--clean");
const BASE_PRICE = 40;
const FLAVORS = ["Cheese", "Sour Cream", "BBQ"];

// Weekday demand weights: school-day traffic, higher Fri-Sun.
const DOW_WEIGHTS = [0.9, 1.1, 1.05, 1.0, 1.15, 1.35, 1.25]; // Sun..Sat
const CART_SCALE = { "CART-01": 1.0, "CART-02": 0.8, "CART-03": 0.65 };

function rand(min, max) {
  return Math.random() * (max - min) + min;
}
function randInt(min, max) {
  return Math.floor(rand(min, max + 1));
}

async function main() {
  const locations = await db.locations.findMany();
  if (locations.length === 0) throw new Error("Run npm run db:seed first");

  if (CLEAN) {
    const all = await db.orders.findMany();
    const old = all.filter((o) => typeof o.clientRef === "string" && o.clientRef.startsWith("hist-"));
    if (old.length > 0) {
      // Items are embedded in the order doc: deleting the order removes them.
      for (let i = 0; i < old.length; i += 400) {
        await Promise.all(old.slice(i, i + 400).map((o) => db.orders.delete({ where: { id: o.id } })));
      }
    }
    console.log(`Cleaned ${old.length} previously seeded history orders.`);
  }

  let orderCount = 0;
  let itemCount = 0;

  for (let d = DAYS; d >= 1; d--) {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - d);
    const dow = date.getDay();

    for (const loc of locations) {
      const scale = CART_SCALE[loc.code] ?? 1;
      const ordersToday = Math.max(
        3,
        Math.round(randInt(18, 42) * DOW_WEIGHTS[dow] * scale)
      );

      for (let o = 0; o < ordersToday; o++) {
        // Selling hours 8:00-17:30
        const created = new Date(date);
        created.setHours(randInt(8, 17), randInt(0, 59), randInt(0, 59));

        const lineCount = randInt(1, 3);
        const items = [];
        for (let li = 0; li < lineCount; li++) {
          const qty = randInt(1, 2);
          items.push({
            productName: "Flavored Fries",
            flavor: FLAVORS[randInt(0, FLAVORS.length - 1)],
            qty,
            unitPrice: BASE_PRICE,
          });
        }
        const total = items.reduce((s, it) => s + it.qty * it.unitPrice, 0);

        // One counter block per order (order id + item ids), like API orders.
        const [orderId, ...itemIds] = await db.orders.nextIds(1 + items.length);
        items.forEach((it, i) => {
          it.id = itemIds[i];
        });
        await db.orders.create({
          data: {
            id: orderId,
            clientRef: `hist-${loc.code}-${d}-${o}-${Math.random()
              .toString(36)
              .slice(2, 8)}`,
            locationId: loc.id,
            staffId: null,
            total,
            status: "PAID",
            createdAt: created,
            syncedAt: created,
            items,
          },
        });
        orderCount++;
        itemCount += items.length;
      }
    }
    process.stdout.write(`\rday -${String(d).padStart(2)} done (${orderCount} orders)`);
  }

  console.log(`\nHistory seeded: ${orderCount} orders / ${itemCount} lines over ${DAYS} days.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
