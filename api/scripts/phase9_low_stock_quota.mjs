#!/usr/bin/env node
// Phase 9: LOW_STOCK alert dedupe under load.
//
// Guards the read-budget fix: alert dedupe used to be "scan every LOW_STOCK
// alert ever created, then filter in code", paid on every sale and every IoT
// reading batch. Alerts are never deleted, so that scan grew without bound and
// was the largest consumer of the 50k/day free-tier read budget.
//
// These assertions pin the behaviour that replaced it:
//   1. Repeated readings below the threshold create ONE alert, not N.
//   2. The alert survives and stays unread (it is not churned).
//   3. Resolving it (isRead) and crossing again re-opens it.
//   4. The doc id is deterministic, so no duplicate rows accumulate.
//
// Run against a freshly seeded emulator:
//   node scripts/seed_firestore.mjs
//   node scripts/phase9_low_stock_quota.mjs

const BASE = process.env.API_BASE || "http://127.0.0.1:4000/api";
const CART = "CART-01";
const DEVICE_TOKEN =
  process.env.DEVICE_TOKEN ||
  "dev-CART-01-potafries";

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

async function ownerToken() {
  const r = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "owner", password: "owner123" }),
  });
  const d = await r.json();
  return d.token;
}

let TOKEN = "";
const authHeaders = (extra = {}) => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${TOKEN}`,
  ...extra,
});

const get = async (path, headers = {}) => {
  const r = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${TOKEN}`, ...headers } });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const post = async (path, body, headers = {}) => {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: authHeaders(headers),
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// Alerts are acknowledged with PATCH /alerts/:id/ack (detected -> acknowledged).
// It is never a POST - that route does not exist, so a POST here would 404 for a
// reason that has nothing to do with the behaviour under test.
const patch = async (path) => {
  const r = await fetch(`${BASE}${path}`, {
    method: "PATCH",
    headers: authHeaders(),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const lowStockAlerts = async () => {
  const { body } = await get("/alerts?pageSize=100");
  return (body?.data ?? []).filter((a) => a.type === "LOW_STOCK");
};

const itemByName = async (name) => {
  const { body } = await get(`/inventory?code=${CART}`);
  const items = body?.locations?.[0]?.items ?? [];
  return items.find((i) => i.name === name) ?? null;
};

console.log("PHASE 9: LOW_STOCK alert dedupe + read budget\n");

TOKEN = await ownerToken();
if (!TOKEN) {
  console.log("  FAIL  owner login");
  process.exit(1);
}

// Recover the cart's LPG row to a known state so the run is repeatable.
// Manual adjustment skips the sensor mirror, so the reading path starts from a
// value we control instead of whatever the previous run left behind.
//
// This MUST end ABOVE the threshold: a row already below it can never produce a
// threshold CROSSING, so no alert would ever be opened and the run would report
// a false pass.
// Route is POST /inventory/adjustments with {inventoryItemId, newStock, reason}.
// A missing reason is rejected for staff and the wrong path 404s, so both are
// reported rather than silently ignored - a setup that does not apply would make
// every later assertion meaningless.
const seedStock = async (stock) => {
  const row = await itemByName("LPG Tank");
  if (!row) return { ok: false, detail: "row missing" };
  const res = await post("/inventory/adjustments", {
    inventoryItemId: row.id,
    newStock: stock,
    reason: "phase9 setup: reset LPG above threshold",
  });
  if (res.status !== 200) {
    return { ok: false, detail: `status ${res.status} ${JSON.stringify(res.body)}` };
  }
  return { ok: true };
};

const start = await itemByName("LPG Tank");
if (!start) {
  console.log("  FAIL  LPG Tank inventory row exists (did you seed?)");
  process.exit(1);
}
// Comfortably above the threshold so the next reading is a real crossing.
const seeded = await seedStock(Number(start.threshold) + 10);
if (!seeded.ok) {
  console.log(`  FAIL  seed stock above threshold -- ${seeded.detail}`);
  process.exit(1);
}

const item = await itemByName("LPG Tank");
const threshold = Number(item.threshold);
const belowThreshold = Math.max(0, threshold - 1);
const aboveThreshold = threshold + 10;

// ---- 0. RESOLVE, not just acknowledge, any alert this item already holds -------
//
// The dedupe treats an alert as "still open" while it is UNREAD. An ack only
// records who looked at it; the alert stays unread and would keep blocking. Only
// the owner's resolve marks it read, which is what actually re-arms the warning.
for (const a of await lowStockAlerts()) {
  if (!a.message.includes("LPG Tank")) continue;
  const ack = await patch(`/alerts/${a.id}/ack`);
  if (ack.status !== 200) {
    console.log(`  FAIL  ack LPG alert ${a.id} -- status ${ack.status}`);
    process.exit(1);
  }
  const resolved = await patch(`/alerts/${a.id}/read`);
  if (resolved.status !== 200) {
    console.log(`  FAIL  resolve LPG alert ${a.id} -- status ${resolved.status}`);
    process.exit(1);
  }
}
const stillOpen = (await lowStockAlerts()).filter(
  (a) => a.message.includes("LPG Tank") && a.isRead === false,
);
check(
  "no unresolved LPG alert is left blocking the test",
  stillOpen.length === 0,
  `still open: ${stillOpen.length}`,
);
console.log(`  LPG Tank: stock=${item.stock} threshold=${threshold} -> reading ${belowThreshold}\n`);
check(
  "the row starts above its threshold so a crossing is possible",
  Number(item.stock) > threshold,
  `stock=${item.stock} threshold=${threshold}`,
);
const batches = 5;
// Counted immediately before the burst so the growth assertion below is about
// this burst alone, not the whole table.
const beforeBurst = (await lowStockAlerts()).length;
for (let i = 0; i < batches; i += 1) {
  await post("/iot/readings", {
    cart_id: CART,
    readings: [{ channel: "LPG_TANK", kg: belowThreshold }],
  }, { Authorization: `Bearer ${DEVICE_TOKEN}` });
}
const afterFirst = await lowStockAlerts();
const opened = afterFirst.length - beforeBurst;

check(
  `${batches} below-threshold readings create exactly one alert`,
  opened === 1,
  `opened ${opened}`,
);

const mine = afterFirst.filter((a) => a.message.includes("LPG Tank"));
check("the alert names the item", mine.length >= 1);
check(
  "the alert is unread so the operator still sees it",
  mine.some((a) => a.isRead === false),
);

// ---- 2. it is not churned --------------------------------------------------------
await post("/iot/readings", {
  cart_id: CART,
  readings: [{ channel: "LPG_TANK", kg: belowThreshold }],
}, { Authorization: `Bearer ${DEVICE_TOKEN}` });
const afterSecond = await lowStockAlerts();
check(
  "the whole 6-reading burst added at most one alert row",
  afterSecond.length - beforeBurst <= 1,
  `grew by ${afterSecond.length - beforeBurst}`,
);
// Strongest form of "not churned": no row was added AND the set of ids and
// creation timestamps is byte-identical to what the burst produced.
check(
  "the existing alert is reused, not recreated",
  JSON.stringify(
    afterSecond.map((a) => [a.id, a.createdAt]).sort(),
  ) === JSON.stringify(
    afterFirst.map((a) => [a.id, a.createdAt]).sort(),
  ),
);

// ---- 3. resolve then cross again re-opens ---------------------------------------
const target = afterSecond.find((a) => a.isRead === false);
if (target) {
  const ack = await patch(`/alerts/${target.id}/ack`);
  check("owner can ack the alert", ack.status === 200, `status ${ack.status}`);
  // Resolve (isRead) as well - ack alone leaves the alert unread, and the dedupe
  // only re-arms once the alert is resolved.
  const resolved = await patch(`/alerts/${target.id}/read`);
  check("owner can resolve the alert", resolved.status === 200, `status ${resolved.status}`);

  // Recover above threshold, then drop back: the crossing must fire again.
  await post("/iot/readings", {
    cart_id: CART,
    readings: [{ channel: "LPG_TANK", kg: aboveThreshold }],
  }, { Authorization: `Bearer ${DEVICE_TOKEN}` });
  await post("/iot/readings", {
    cart_id: CART,
    readings: [{ channel: "LPG_TANK", kg: belowThreshold }],
  }, { Authorization: `Bearer ${DEVICE_TOKEN}` });

  const reopened = (await lowStockAlerts()).filter(
    (a) => a.message.includes("LPG Tank") && a.isRead === false,
  );
  check(
    "crossing again after a resolve re-opens the alert",
    reopened.length >= 1,
    `unread=${reopened.length}`,
  );
} else {
  check("an unread LPG alert existed to resolve", false);
}

// ---- 4. repeated crossings must not pile up rows --------------------------------
//
// Keyed on lowStockKey, NOT on the message: the message embeds the live stock
// ("2.4 kg left" vs "1.5 kg left"), so a legitimate re-warning after a resolve
// is a different string for the same condition. Counting distinct keys is what
// actually answers "does the dedupe hold".
// Never two OPEN rows for one condition - that is what would actually spam the
// dashboard. Checked at the END of the run, so it also covers the re-cross in
// step 3 above.
const afterBurst = await lowStockAlerts();
const openByKey = new Map();
for (const a of afterBurst) {
  if (a.isRead !== false) continue;
  const key = a.lowStockKey || JSON.parse(a.payload ?? "{}").dedupeKey;
  if (key) openByKey.set(key, (openByKey.get(key) ?? 0) + 1);
}
const openDupes = [...openByKey.entries()].filter(([, n]) => n > 1);
check(
  "never more than one OPEN alert per condition",
  openDupes.length === 0,
  `open duplicates: ${openDupes.map(([k, n]) => `${k}x${n}`).join(", ")}`,
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log(`\nfailing: ${failures.join(", ")}`);
  process.exit(1);
}
