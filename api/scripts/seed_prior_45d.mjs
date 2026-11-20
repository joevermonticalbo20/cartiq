#!/usr/bin/env node
// Fills the 45 days BEFORE the recent demo history (d = 59..15 days ago, i.e.
// Sep 22..Nov 5 when run on Nov 20). The Analytics KPI cards compare the
// selected window against the immediately previous window; without orders in
// that previous window the "vs prior period" badges are hidden by design.
//
//   node scripts/seed_prior_45d.mjs
//
// clientRef prefix `histp-` so seed_14d_fast.mjs (which removes `hist-`) and
// seed_today.mjs never touch these rows, and rerunning this script only
// replaces its own data.
import "dotenv/config";
import { db } from "../src/firestore.js";

const FROM_DAYS_AGO = 59; // Sep 22
const TO_DAYS_AGO = 15; // Nov 5
const SCALE = Number(process.env.SCALE) || 0.85;
const DOW_WEIGHTS = [0.9, 1.1, 1.05, 1.0, 1.15, 1.35, 1.25]; // Sun..Sat
const CART_SCALE = { "CART-01": 1.0, "CART-02": 0.8, "CART-03": 0.65 };
const PREFIX = "histp-";
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

function pickWeighted(rows) {
  const total = rows.reduce((s, r) => s + r.weight, 0);
  let roll = Math.random() * total;
  for (const row of rows) {
    roll -= row.weight;
    if (roll <= 0) return row;
  }
  return rows[rows.length - 1];
}

function makeItems() {
  const lines = randInt(1, 3);
  const items = [];
  for (let i = 0; i < lines; i++) {
    const size = pickWeighted(SIZES);
    items.push({
      productName: PRODUCTS[randInt(0, PRODUCTS.length - 1)],
      flavor: size.name,
      qty: randInt(1, 2),
      unitPrice: size.price,
    });
  }
  return items;
}

async function cleanPrior() {
  const all = await db.orders.findMany();
  const old = all.filter(
    (o) => typeof o.clientRef === "string" && o.clientRef.startsWith(PREFIX)
  );
  for (let i = 0; i < old.length; i += 300) {
    await Promise.all(
      old.slice(i, i + 300).map((o) => db.orders.delete({ where: { id: o.id } }))
    );
  }
  return old.length;
}

async function main() {
  const locations = await db.locations.findMany();
  const carts = locations.filter(
    (l) => l.status === "ACTIVE" && CART_SCALE[l.code] != null
  );
  if (carts.length === 0) throw new Error("No active carts found.");

  const removed = await cleanPrior();
  console.log(`Cleaned ${removed} previously seeded prior-period orders.`);

  let orderCount = 0;
  let dayCount = 0;
  const started = Date.now();

  for (let d = FROM_DAYS_AGO; d >= TO_DAYS_AGO; d--) {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    dayStart.setDate(dayStart.getDate() - d);
    const base = Math.round(
      randInt(11, 20) * DOW_WEIGHTS[dayStart.getDay()] * SCALE
    );

    const jobs = [];
    for (const cart of carts) {
      const count = Math.max(3, Math.round(base * CART_SCALE[cart.code]));
      const ids = await db.orders.nextIds(count * 4);
      let cursor = 0;
      for (let o = 0; o < count; o++) {
        const orderId = ids[cursor++];
        const items = makeItems();
        for (const item of items) item.id = ids[cursor++];
        const created = new Date(dayStart);
        created.setHours(randInt(8, 17), randInt(0, 59), randInt(0, 59), 0);
        jobs.push({
          id: orderId,
          clientRef: `${PREFIX}${cart.code}-${d}-${o}-${Math.random()
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
    orderCount += jobs.length;
    dayCount++;
    console.log(
      `day -${String(d).padStart(2)} ${dayStart.toISOString().slice(0, 10)}: +${jobs.length} (total ${orderCount})`
    );
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `Done: ${orderCount} orders over ${dayCount} distinct days in ${secs}s.`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
