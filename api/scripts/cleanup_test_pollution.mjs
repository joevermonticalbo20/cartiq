#!/usr/bin/env node
// Removes test junk accidentally written to PROD by a mis-targeted regression
// run (suites hit :4000 prod API instead of the emulator).
//
//   node scripts/cleanup_test_pollution.mjs                  # dry run vs PROD
//   node scripts/cleanup_test_pollution.mjs --commit --prod  # DELETE vs PROD
//   node scripts/cleanup_test_pollution.mjs --commit --emulator  # test vs emulator
//
// Safety:
//  - Refuses to run with --commit unless exactly one of --prod/--emulator.
//  - Refuses --prod when FIRESTORE_EMULATOR_HOST is set (likely mis-target).
//  - All filters are tight: test-only prefixes/vendors + 12h time window.
//  - Deleted PAID orders get their recipe stock RESTOCKED first (with audit
//    stockAdjustment rows). VOID orders restock only when no prior
//    "VOID order #id" restore adjustment exists.
//  - Sensor-overwritten inventory rows (LPG Tank/Cheese Powder @ CART-01) can
//    NOT be auto-restored (prior values unknown) — reported for recount.
import "dotenv/config";
import { db } from "../src/firestore.js";
import { planVoidRestores } from "../src/services/inventory_rules.js";

const COMMIT = process.argv.includes("--commit");
const USE_PROD = process.argv.includes("--prod");
const USE_EMU = process.argv.includes("--emulator");
const WINDOW_MS = 12 * 60 * 60 * 1000;
const cutoff = new Date(Date.now() - WINDOW_MS);

if (COMMIT && ((USE_PROD && USE_EMU) || (!USE_PROD && !USE_EMU))) {
  console.error("Refusing: --commit needs exactly one of --prod or --emulator.");
  process.exit(2);
}
if (USE_PROD && process.env.FIRESTORE_EMULATOR_HOST) {
  console.error("Refusing: FIRESTORE_EMULATOR_HOST is set but --prod requested. Unset it first.");
  process.exit(2);
}
console.log(`Target: ${USE_EMU ? "EMULATOR" : "PROD cartiq-8e46f"}  commit=${COMMIT}  window_since=${cutoff.toISOString()}`);

const inWindow = (d) => d && new Date(d).getTime() >= cutoff.getTime();
const results = [];
const log = (action, detail) => { results.push(`${action} ${detail}`); console.log(`${COMMIT ? "[DEL] " : "[WOULD] "}${action} ${detail}`); };

async function main() {
  const owner = await db.users.findUnique({ where: { username: "owner" } });

  // ---- 1. test users ----
  const users = await db.users.findMany();
  const testUsers = users.filter((u) => u.username?.startsWith("teststaff_"));
  for (const u of testUsers) {
    log(`user @${u.username} (active=${u.active})`, `id=${u.id}`);
    if (COMMIT) {
      const tokens = await db.refreshTokens.findMany({ where: { userId: u.id } });
      for (const t of tokens) await db.refreshTokens.delete({ where: { id: t.id } });
      await db.users.delete({ where: { id: u.id } });
    }
  }

  // ---- 2. test products ----
  const products = await db.products.findMany();
  const testProducts = products.filter((p) => p.name?.startsWith("Test Dip Sauce ") || p.name?.startsWith("Test Bucket "));
  for (const p of testProducts) {
    log(`product "${p.name}"`, `id=${p.id}`);
    if (COMMIT) await db.products.delete({ where: { id: p.id } });
  }

  // ---- 3. test orders (+ restock) ----
  const prefixes = ["void-test-", "phase7-void-", "phase7-pay-", "phase7-nopay-", "phase7-race-"];
  const orders = await db.orders.findMany({ include: { items: true } });
  const testOrders = orders.filter((o) => prefixes.some((p) => o.clientRef?.startsWith(p)));
  const maps = await db.ingredientMaps.findMany();
  const [adjOwner, adjustments] = await Promise.all([
    owner,
    db.stockAdjustments.findMany(),
  ]);
  for (const o of testOrders) {
    const hasRestore = adjustments.some((a) => typeof a.reason === "string" && a.reason.includes(`VOID order #${o.id}`));
    const needsRestock = o.status !== "VOID" || !hasRestore;
    log(`order #${o.id} ${o.status} clientRef=${o.clientRef} total=${o.total}${needsRestock ? " +RESTOCK" : " (already restored)"}`, "");
    if (COMMIT && needsRestock) {
      const invRows = await db.inventoryItems.findMany({ where: { locationId: o.locationId } });
      // Same shared restore planner as the POS void path, so a restock here
      // can never disagree with a real VOID. Its warnings are logged: an
      // unmatched recipe means this order canNOT be restocked, and staying
      // silent about that is how stock quietly drifted before.
      const { restores: adds, warnings } = planVoidRestores(o.items ?? [], maps, invRows);
      for (const w of warnings) log(`  order #${o.id} WARNING: ${w}`, "");
      const alloc = adds.size ? await db.stockAdjustments.nextIds(adds.size) : [];
      const [adjIds] = [alloc];
      let i = 0;
      for (const { inv, newStock } of adds.values()) {
        await db.inventoryItems.update({ where: { id: inv.id }, data: { stock: newStock } });
        await db.stockAdjustments.create({
          data: {
            id: adjIds[i++],
            inventoryItemId: inv.id,
            locationId: inv.locationId,
            actorId: adjOwner?.id ?? null,
            before: inv.stock,
            after: newStock,
            reason: `cleanup: restock for deleted test order #${o.id} (${o.clientRef})`.slice(0, 500),
          },
        });
      }
      await db.orders.delete({ where: { id: o.id } });
      try { await db.collection("orderRefs").doc(String(o.clientRef)).delete(); } catch {}
    } else if (COMMIT) {
      await db.orders.delete({ where: { id: o.id } });
      try { await db.collection("orderRefs").doc(String(o.clientRef)).delete(); } catch {}
    }
  }

  // ---- 4. test expenses ----
  const expenses = await db.expenses.findMany();
  const testExpenses = expenses.filter((e) =>
    inWindow(e.date) &&
    ((e.vendor === "XYZ Gas Station" && Number(e.amount) === 650) ||
      e.vendor === "Default Cat Probe" ||
      (e.vendor?.startsWith("Probe ") && Number(e.amount) === 50)));
  for (const e of testExpenses) {
    log(`expense "${e.vendor}" ${e.amount} cat=${e.category}`, `id=${e.id}`);
    if (COMMIT) await db.expenses.delete({ where: { id: e.id } });
  }

  // ---- 5. test sensor readings ----
  const readings = await db.sensorReadings.findMany();
  const testReadings = readings.filter((r) =>
    r.deviceId === "esp32-cart-01" &&
    ["LPG_TANK", "CHEESE_BIN"].includes(r.channel) &&
    [9.5, 2.8, 2.4, 2.3].includes(Number(r.kg)) &&
    inWindow(r.ts));
  for (const r of testReadings) {
    log(`reading ${r.channel}=${r.kg}kg`, `id=${r.id}`);
    if (COMMIT) await db.sensorReadings.delete({ where: { id: r.id } });
  }

  // ---- 6. test shifts ----
  const shifts = await db.shifts.findMany();
  const testShifts = shifts.filter((s) =>
    inWindow(s.ts) &&
    (s.staffUid === "04A2B3C4" || s.staffUid === "DEADBEEF" || s.staffUid?.startsWith("H7-")));
  for (const s of testShifts) {
    log(`shift ${s.staffUid} ${s.event}`, `id=${s.id}`);
    if (COMMIT) await db.shifts.delete({ where: { id: s.id } });
  }

  // ---- 7. test alerts ----
  const alerts = await db.alerts.findMany();
  const testAlerts = alerts.filter((a) => {
    if (!inWindow(a.createdAt)) return false;
    if (a.type === "LOW_STOCK" && (a.message ?? "").includes("LPG Tank @ CART-01")) return true;
    if (a.type === "UNKNOWN_CARD" && ((a.message ?? "").includes("DEADBEEF") || (a.message ?? "").includes("H7-"))) return true;
    try {
      const p = JSON.parse(a.payload ?? "{}");
      if (typeof p.reason === "string" && p.reason.includes("phase5 H2 no-op check")) return true;
    } catch {}
    return false;
  });
  for (const a of testAlerts) {
    log(`alert ${a.type} "${(a.message ?? "").slice(0, 70)}"`, `id=${a.id}`);
    if (COMMIT) await db.alerts.delete({ where: { id: a.id } });
  }

  // ---- 8. report: sensor-clobbered inventory (NO auto-fix) ----
  const cart01 = await db.locations.findUnique({ where: { code: "CART-01" } });
  if (cart01) {
    const items = await db.inventoryItems.findMany({ where: { locationId: cart01.id } });
    for (const it of items.filter((x) => ["LPG Tank", "Cheese Powder"].includes(x.name))) {
      console.log(`[REPORT] CART-01 "${it.name}" now ${it.stock}${it.unit} source=${it.source} updatedAt=${it.updatedAt?.toISOString?.() ?? it.updatedAt} — prior value unknown (phase2 sensor mirror). Recommend physical recount + POST /inventory/adjustments.`);
    }
  }

  console.log(`\n${results.length} candidate rows. commit=${COMMIT}`);
}

main()
  .catch((e) => { console.error("Cleanup crashed:", e.message); process.exit(1); })
  .finally(async () => { await db.$disconnect(); });
