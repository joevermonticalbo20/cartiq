#!/usr/bin/env node
// Seeds realistic daily expenses (Supplies + LPG) proportional to the demo
// orders' revenue, so the Analytics Profit section shows a believable margin
// instead of 100%. Only touches rows whose note starts with "hist-seed".
//
//   node scripts/seed_expenses.mjs
import "dotenv/config";
import { db } from "../src/firestore.js";

const rand = (min, max) => Math.random() * (max - min) + min;
const manilaKey = (d) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);

async function main() {
  const all = await db.expenses.findMany();
  const old = all.filter(
    (e) => typeof e.note === "string" && e.note.startsWith("hist-seed")
  );
  for (let i = 0; i < old.length; i += 300) {
    await Promise.all(
      old.slice(i, i + 300).map((e) => db.expenses.delete({ where: { id: e.id } }))
    );
  }

  const orders = await db.orders.findMany();
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - 14);

  const revenue = new Map(); // `${locId}|${key}` -> revenue
  for (const o of orders) {
    if (o.status !== "PAID" || !o.createdAt) continue;
    const created = new Date(o.createdAt);
    if (created < since) continue;
    const key = `${o.locationId}|${manilaKey(created)}`;
    revenue.set(key, (revenue.get(key) ?? 0) + Number(o.total || 0));
  }

  const rows = [];
  for (const [key, total] of revenue) {
    const [locId, dayKey] = key.split("|");
    const supplies = Math.round(total * rand(0.22, 0.26));
    const lpg = Math.round(total * rand(0.04, 0.06));
    const noon = new Date(`${dayKey}T12:00:00+08:00`);
    for (const [category, amount] of [
      ["Supplies", supplies],
      ["LPG/Gas", lpg],
    ]) {
      if (amount <= 0) continue;
      rows.push({
        locationId: Number(locId),
        source: "MANUAL",
        category,
        amount,
        date: noon,
        note: `hist-seed demo expense (${dayKey})`,
        lines: null,
        createdAt: new Date(),
      });
    }
  }

  for (let i = 0; i < rows.length; i += 8) {
    const batch = rows.slice(i, i + 8);
    const ids = await db.expenses.nextIds(batch.length);
    await Promise.all(
      batch.map((data, j) => db.expenses.create({ data: { ...data, id: ids[j] } }))
    );
  }
  console.log(`Seeded ${rows.length} demo expense rows across ${revenue.size} cart-days.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
