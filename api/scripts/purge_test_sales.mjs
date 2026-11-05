// One-off production purge of the test sales (local script, never deployed).
// Deletes every document in `orders`, `orderRefs` and `orderReceipts`, plus
// SALE/VOID_REQUEST alerts (all are sale-derived test noise). Keeps
// RESTOCK_REQUEST, LOW_STOCK, UNKNOWN_CARD and everything else — operational
// alerts are not sales data.
//
//   node scripts/purge_test_sales.mjs --dry-run
//   node scripts/purge_test_sales.mjs --confirm "DELETE ALL SALES"
//   node scripts/purge_test_sales.mjs --confirm "DELETE ALL SALES" --reset-order-counter
//
// --reset-order-counter makes the next sale #1 again (the order number is
// otherwise monotonic even after every order is deleted). Refuses to run
// without the local backup from scripts/backup_firestore.mjs (checked at
// .backups/<today>/_summary.json), because there is no undo.
import "dotenv/config";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { initializeApp, getApps, applicationDefault, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const todayDir = join(root, ".backups", new Date().toISOString().slice(0, 10));
const confirmIdx = process.argv.indexOf("--confirm");
const confirmed = confirmIdx > -1 && process.argv[confirmIdx + 1] === "DELETE ALL SALES";
const dryRun = process.argv.includes("--dry-run");

if (!existsSync(join(todayDir, "_summary.json"))) {
  console.error(`Refusing to run: no backup found for today (${todayDir}). Run backup_firestore.mjs first.`);
  process.exit(1);
}
const backup = JSON.parse(readFileSync(join(todayDir, "_summary.json"), "utf8"));
console.log(`Backup verified: ${todayDir} (${backup.collections.length} collections)`);

if (getApps().length === 0) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)), projectId: process.env.FIREBASE_PROJECT_ID || "cartiq-8e46f" });
  } else {
    initializeApp({ credential: applicationDefault(), projectId: process.env.FIREBASE_PROJECT_ID || "cartiq-8e46f" });
  }
}
const fs = getFirestore();

async function refsFor(collection) {
  const snap = await fs.collection(collection).get();
  return snap.docs.map((d) => d.ref);
}

const orderRefs = await refsFor("orders");
const refRefs = await refsFor("orderRefs");
const receiptRefs = await refsFor("orderReceipts");
const alertSnap = await fs.collection("alerts").get();
const saleAlertRefs = alertSnap.docs.filter((d) => ["SALE", "VOID_REQUEST"].includes(d.data()?.type)).map((d) => d.ref);

console.log(`orders:        ${orderRefs.length}`);
console.log(`orderRefs:     ${refRefs.length}`);
console.log(`orderReceipts: ${receiptRefs.length}`);
console.log(`SALE/VOID alerts: ${saleAlertRefs.length}`);

if (dryRun) {
  console.log("\nDRY RUN - nothing deleted.");
  process.exit(0);
}
if (!confirmed) {
  console.error('Refusing to run: pass --confirm "DELETE ALL SALES" to delete.');
  process.exit(1);
}

async function deleteInBatches(label, refs) {
  let done = 0;
  for (let i = 0; i < refs.length; i += 400) {
    const batch = fs.batch();
    for (const ref of refs.slice(i, i + 400)) batch.delete(ref);
    await batch.commit();
    done += Math.min(400, refs.length - i);
  }
  console.log(`${label}: deleted ${done}`);
}

await deleteInBatches("orders", orderRefs);
await deleteInBatches("orderRefs", refRefs);
await deleteInBatches("orderReceipts", receiptRefs);
await deleteInBatches("SALE/VOID alerts", saleAlertRefs);

if (process.argv.includes("--reset-order-counter")) {
  await fs.collection("_counters").doc("orders").set({ next: 1 }, { merge: true });
  console.log("orders counter reset: the next sale is #1");
}

const remaining = {
  orders: (await fs.collection("orders").get()).size,
  orderRefs: (await fs.collection("orderRefs").get()).size,
  orderReceipts: (await fs.collection("orderReceipts").get()).size,
  saleAlerts: (await fs.collection("alerts").get()).docs.filter((d) => ["SALE", "VOID_REQUEST"].includes(d.data()?.type)).length,
};
console.log("\nRemaining:", JSON.stringify(remaining));
console.log("Purge complete. SALE/VOID_REQUEST alerts removed; operational alerts kept. Stock was NOT restored (same semantics as the October purge).");
