#!/usr/bin/env node
// Phase 2 IoT pipeline integration test.
// Run with the API already listening on 127.0.0.1:4000:
//   npm run dev            (terminal 1)
//   node scripts/phase2_test.mjs   (terminal 2)

const BASE = "http://127.0.0.1:4000/api";
const DEV_TOKEN = "dev-CART-01-potafries";

let passed = 0;
let failed = 0;

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name} ${detail}`);
  }
}

async function req(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

async function main() {
  const login = await req("/auth/login", {
    method: "POST",
    body: { username: "owner", password: "owner123" },
  });
  check("owner login", login.status === 200);
  const ownerTok = login.data?.token;

  // 1. device auth
  const bad = await req("/iot/readings", {
    method: "POST",
    token: "wrong-token",
    body: { readings: [{ channel: "LPG_TANK", kg: 10 }] },
  });
  check("bad device token rejected 401", bad.status === 401);

  // 2. valid readings update inventory
  const r1 = await req("/iot/readings", {
    method: "POST",
    token: DEV_TOKEN,
    body: {
      readings: [
        { channel: "LPG_TANK", kg: 9.5 },
        { channel: "CHEESE_BIN", kg: 2.8 },
      ],
    },
  });
  check("readings accepted", r1.status === 201 && r1.data.accepted.length === 2);

  const inv = await req("/inventory?code=CART-01", { token: ownerTok });
  const lpg = inv.data.locations[0].items.find((i) => i.name === "LPG Tank");
  const cheese = inv.data.locations[0].items.find((i) => i.name === "Cheese Powder");
  check("LPG stock mirrors sensor (9.5)", lpg?.stock === 9.5 && lpg?.source === "SENSOR");
  check("Cheese bin mirrors sensor (2.8)", cheese?.stock === 2.8);

  // 3. threshold crossing -> exactly one alert even after repeated lows
  await req("/iot/readings", {
    method: "POST",
    token: DEV_TOKEN,
    body: { readings: [{ channel: "LPG_TANK", kg: 2.4 }] },
  });
  await req("/iot/readings", {
    method: "POST",
    token: DEV_TOKEN,
    body: { readings: [{ channel: "LPG_TANK", kg: 2.3 }] },
  });
  const alerts1 = await req("/alerts?unread_only=true", { token: ownerTok });
  const lowAlerts = alerts1.data.data.filter(
    (a) => a.type === "LOW_STOCK" && a.message.includes("LPG Tank")
  );
  check("LOW_STOCK alert fired once for LPG", lowAlerts.length === 1);

  // 4. RFID known card
  const tapIn = await req("/shifts", {
    method: "POST",
    token: DEV_TOKEN,
    body: { events: [{ staff_uid: "04A2B3C4", event: "IN" }] },
  });
  check("known UID matched to staff", tapIn.data.accepted[0]?.matched === "Stall Staff 1");

  // 5. unknown card -> alert, still recorded
  await req("/shifts", {
    method: "POST",
    token: DEV_TOKEN,
    body: { events: [{ staff_uid: "DEADBEEF", event: "IN" }] },
  });
  const alerts2 = await req("/alerts?unread_only=true", { token: ownerTok });
  const unknown = alerts2.data.data.filter((a) => a.type === "UNKNOWN_CARD");
  check("UNKNOWN_CARD alert created", unknown.length === 1);

  // 6. on-shift view
  const onShift = await req("/staff/on-shift", { token: ownerTok });
  const staff1 = onShift.data.on_shift.find((s) => s.name === "Stall Staff 1");
  const ghost = onShift.data.on_shift.find((s) => s.name?.includes("Unregistered"));
  check("staff01 shown ON SHIFT", Boolean(staff1));
  check("unknown card shown unregistered on shift", Boolean(ghost));

  // 7. readings series endpoint
  const series = await req("/readings/recent?code=CART-01&channel=LPG_TANK", { token: ownerTok });
  check("readings series returned", series.data.readings.length >= 3);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("Test crashed:", e.message);
  process.exit(1);
});
