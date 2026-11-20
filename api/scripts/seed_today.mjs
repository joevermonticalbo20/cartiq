#!/usr/bin/env node
// Seeds ~40 demo orders for TODAY (Manila) so the analytics chart's last bar and
// the sales forecast holdout window are populated on demo day. Same doc shape as
// seed_14d_fast.mjs; clientRef prefix hist- so cleanup scripts remove them.
//
//   node scripts/seed_today.mjs
import "dotenv/config";
import { db } from "../src/firestore.js";

const CART_SCALE = { "CART-01": 1.0, "CART-02": 0.8, "CART-03": 0.65 };
const PRODUCTS = [
  "BBQ Fries",
  "Caramel Fries",
  "Cheese Fries",
  "Chili BBQ Fries",
  "Chili Cheese Fries",
  "Honey Butter Fries",
  "Sour Cream Fries",
  "Sweet Corn Fries",
];
const SIZES = [
  { name: "Medium", price: 20, weight: 0.55 },
  { name: "Large", price: 30, weight: 0.3 },
  { name: "XL 40", price: 40, weight: 0.1 },
  { name: "XL 50", price: 50, weight: 0.05 },
];

const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function pickSize() {
  const total = SIZES.reduce((s, r) => s + r.weight, 0);
  let roll = Math.random() * total;
  for (const row of SIZES) {
    roll -= row.weight;
    if (roll <= 0) return row;
  }
  return SIZES[SIZES.length - 1];
}

async function main() {
  const locations = await db.locations.findMany();
  const carts = locations.filter(
    (l) => l.status === "ACTIVE" && CART_SCALE[l.code] != null
  );
  if (carts.length === 0) throw new Error("No active carts found.");

  const todayKey = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  // Remove a previous run for today only (day segment is 0).
  const all = await db.orders.findMany();
  const todayRef = /^hist-[A-Za-z0-9]+-0-\d+-/;
  const old = all.filter(
    (o) => typeof o.clientRef === "string" && todayRef.test(o.clientRef)
  );
  for (let i = 0; i < old.length; i += 300) {
    await Promise.all(
      old.slice(i, i + 300).map((o) => db.orders.delete({ where: { id: o.id } }))
    );
  }

  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);

  const jobs = [];
  for (const cart of carts) {
    const count = Math.max(8, Math.round(18 * CART_SCALE[cart.code]));
    const ids = await db.orders.nextIds(count * 4);
    let cursor = 0;
    for (let o = 0; o < count; o++) {
      const orderId = ids[cursor++];
      const lines = randInt(1, 3);
      const items = [];
      for (let i = 0; i < lines; i++) {
        const size = pickSize();
        items.push({
          id: ids[cursor++],
          productName: PRODUCTS[randInt(0, PRODUCTS.length - 1)],
          flavor: size.name,
          qty: randInt(1, 2),
          unitPrice: size.price,
        });
      }
      const created = new Date(dayStart);
      created.setHours(randInt(8, 15), randInt(0, 59), randInt(0, 59), 0);
      jobs.push({
        id: orderId,
        clientRef: `hist-${cart.code}-0-${o}-${Math.random()
          .toString(36)
          .slice(2, 8)}`,
        locationId: cart.id,
        staffId: 2,
        total: items.reduce((s, it) => s + it.qty * it.unitPrice, 0),
        status: "PAID",
        paymentMethod: Math.random() < 0.78 ? "CASH" : "GCASH",
        createdAt: created,
        syncedAt: created,
        items,
      });
    }
  }

  for (let i = 0; i < jobs.length; i += 8) {
    await Promise.all(
      jobs.slice(i, i + 8).map((data) => db.orders.create({ data }))
    );
  }
  console.log(`Today (${todayKey} Manila): seeded ${jobs.length} orders.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
