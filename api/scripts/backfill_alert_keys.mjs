#!/usr/bin/env node
// Backfill structured dedupeKey for pre-fix LOW_STOCK / UNKNOWN_CARD alerts.
//
// Old rows have payloads without dedupeKey (or message-only dedupe via
// substring). This script parses them, writes dedupeKey, and marks all but
// the newest per key as read. SAFE: dry-run by default, use --commit to write.
//
// Usage:
//   node scripts/backfill_alert_keys.mjs            # dry run vs emulator
//   node scripts/backfill_alert_keys.mjs --commit   # write
//   FIRESTORE_EMULATOR_HOST=... node scripts/backfill_alert_keys.mjs --commit
import "../src/firestore.js";
import { db } from "../src/firestore.js";

const COMMIT = process.argv.includes("--commit");

function oldKey(alert) {
  try {
    const p = JSON.parse(alert.payload ?? "{}");
    if (p.dedupeKey) return p.dedupeKey;
    if (alert.type === "LOW_STOCK" && p.inventoryItemId && p.locationId) {
      return `low:${p.locationId}:${p.inventoryItemId}`;
    }
    if (alert.type === "UNKNOWN_CARD" && (p.uid || p.locationCode)) {
      // Legacy payload lacks locationId; fall back to message parse below.
      if (p.uid && p.locationId) return `unknown:${p.locationId}:${p.uid}`;
    }
  } catch {}
  // Message fallbacks for very old rows.
  const m = alert.message ?? "";
  const low = m.match(/(.+)\s@\s(\S+)\s(dropped|set)/);
  if (alert.type === "LOW_STOCK" && low) return `legacy-low:${low[2]}:${low[1]}`;
  const unk = m.match(/Unknown RFID card (\S+).*?(\S+)\s-\sregister/);
  if (alert.type === "UNKNOWN_CARD" && unk) return `legacy-unknown:${unk[2]}:${unk[1]}`;
  return null;
}

const alerts = await db.alert.findMany({ orderBy: { createdAt: "desc" } });
const byKey = new Map();
let withKey = 0;
let legacy = 0;
let noKey = 0;
for (const a of alerts) {
  const k = oldKey(a);
  if (!k) { noKey++; continue; }
  if (k.startsWith("legacy-")) legacy++;
  else withKey++;
  if (!byKey.has(k)) byKey.set(k, []);
  byKey.get(k).push(a);
}

let toUpdate = 0;
let toMarkRead = 0;
for (const [key, rows] of byKey) {
  // Newest keeps unread state; older duplicates get marked read.
  rows.slice(1).filter((r) => !r.isRead).forEach(() => toMarkRead++);
  // Legacy rows without structured payload get dedupeKey written.
  rows.forEach((r) => {
    try {
      if (!JSON.parse(r.payload ?? "{}")?.dedupeKey && !key.startsWith("legacy-")) toUpdate++;
      else if (key.startsWith("legacy-")) toUpdate++;
    } catch { toUpdate++; }
  });
}

console.log(`alerts=${alerts.length} structured=${withKey} legacy=${legacy} unparseable=${noKey} groups=${byKey.size}`);
console.log(`would update payloads=${toUpdate} would mark-read duplicates=${toMarkRead} commit=${COMMIT}`);

if (!COMMIT) {
  console.log("Dry run only. Re-run with --commit to write.");
  process.exit(0);
}

for (const [key, rows] of byKey) {
  for (const [idx, r] of rows.entries()) {
    const patch = {};
    try {
      const p = JSON.parse(r.payload ?? "{}");
      if (!p.dedupeKey) {
        p.dedupeKey = key;
        patch.payload = JSON.stringify(p);
      }
    } catch {
      patch.payload = JSON.stringify({ dedupeKey: key });
    }
    if (idx > 0 && !r.isRead) patch.isRead = true;
    if (Object.keys(patch).length > 0) {
      await db.alert.update({ where: { id: r.id }, data: patch });
    }
  }
}
console.log("Backfill committed.");
process.exit(0);
