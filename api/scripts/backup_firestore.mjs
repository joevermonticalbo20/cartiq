// Local Firestore backup dump (read-only). Used ahead of maintenance work so
// any irreversible operation can be reconstructed from this folder.
//
//   node scripts/backup_firestore.mjs [--dry-run]
//
// Writes one JSON file per collection to .backups/<stamp>/ at the repo root.
// Nothing is modified; credentials come from api/.env (GOOGLE_APPLICATION_CREDENTIALS).
import "dotenv/config";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { initializeApp, getApps, applicationDefault, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const COLLECTIONS = [
  "orders",
  "orderRefs",
  "orderReceipts",
  "alerts",
  "products",
  "flavors",
  "ingredientMaps",
  "productImages",
  "_counters",
  "locations",
  "users",
  "inventoryItems",
  "stockAdjustments",
];

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const stamp = new Date().toISOString().slice(0, 10);
const outDir = join(root, ".backups", stamp);
mkdirSync(outDir, { recursive: true });

if (getApps().length === 0) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)), projectId: process.env.FIREBASE_PROJECT_ID || "cartiq-8e46f" });
  } else {
    initializeApp({ credential: applicationDefault(), projectId: process.env.FIREBASE_PROJECT_ID || "cartiq-8e46f" });
  }
}

const db = getFirestore();
const dryRun = process.argv.includes("--dry-run");

const summary = [];
for (const col of COLLECTIONS) {
  const snap = await db.collection(col).get();
  const rows = {};
  for (const doc of snap.docs) rows[doc.id] = doc.data();
  const bytes = JSON.stringify(rows, null, 2).length;
  summary.push({ col, docs: snap.size, bytes });
  console.log(`${col.padEnd(22)} ${String(snap.size).padStart(5)} docs  ${(bytes / 1024).toFixed(0)} KB`);
  if (!dryRun) writeFileSync(join(outDir, `${col}.json`), JSON.stringify(rows, null, 2));
}

writeFileSync(
  join(outDir, "_summary.json"),
  JSON.stringify({ at: new Date().toISOString(), projectId: process.env.FIREBASE_PROJECT_ID || "cartiq-8e46f", collections: summary }, null, 2),
);
console.log(`\n${dryRun ? "DRY RUN - nothing written" : `Backup complete: ${outDir}`}`);
