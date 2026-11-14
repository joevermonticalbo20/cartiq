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

  // 4. a tap nobody asked for leaves no trace
  //    The reader posts every tap it sees. Only a tap that resolves an open
  //    claim (the app asked for a clock-in or a card registration) is recorded.
  const strayTap = await req("/shifts", {
    method: "POST",
    token: DEV_TOKEN,
    body: { events: [{ staff_uid: "04A2B3C4", event: "IN" }] },
  });
  check("a tap with nothing pending records nothing",
        strayTap.status === 201 &&
        (strayTap.data.accepted ?? []).length === 0 &&
        (strayTap.data.rejected ?? []).length === 0);

  // 5. a deliberate tap - the app opened a claim - is the one that counts
  // Open the clock window first so a clock-in is allowed in the test.
  await req("/settings/timeclock", {
    method: "PUT",
    token: ownerTok,
    body: {
      enabled: true,
      inOpen: "00:00",
      inClose: "23:59",
      outOpen: "00:00",
      outClose: "23:59",
      days: [0, 1, 2, 3, 4, 5, 6],
    },
  });
  const staffList = await req("/staff", { token: ownerTok });
  const staffOne = staffList.data?.data?.find((u) => u.rfidUid === "04A2B3C4");
  const claim = await req("/auth/my-rfid/claim", {
    method: "POST",
    token: ownerTok,
    body: { event: "IN", targetUserId: staffOne?.id },
  });
  check("claim opened for the staff card",
        claim.status === 201 && Boolean(claim.data?.claim?.claimId));
  const tapIn = await req("/shifts", {
    method: "POST",
    token: DEV_TOKEN,
    body: { events: [{ staff_uid: "04A2B3C4", event: "IN" }] },
  });
  check("known UID matched to staff", tapIn.data.accepted[0]?.matched === "Stall Staff 1");
  const claimAfter = await req(`/auth/my-rfid/claim/${claim.data?.claim?.claimId}`, { token: ownerTok });
  check("the claim says the shift was written",
        claimAfter.data?.claim?.resolvedEvent === "IN");

  // 6. an unknown card with a claim open is refused, and records nothing
  const unknownClaim = await req("/auth/my-rfid/claim", {
    method: "POST",
    token: ownerTok,
    body: { event: "IN", targetUserId: staffOne?.id },
  });
  await req("/shifts", {
    method: "POST",
    token: DEV_TOKEN,
    body: { events: [{ staff_uid: "DEADBEEF", event: "IN" }] },
  });
  const unknownView = await req(`/auth/my-rfid/claim/${unknownClaim.data?.claim?.claimId}`, { token: ownerTok });
  check("an unknown card is refused by the claim",
        unknownView.data?.claim?.status === "unregistered");
  const alerts2 = await req("/alerts?unread_only=true", { token: ownerTok });
  const unknown = alerts2.data.data.filter((a) => a.type === "UNKNOWN_CARD");
  check("no UNKNOWN_CARD alert is raised", unknown.length === 0);

  // 7. on-shift view
  const onShift = await req("/staff/on-shift", { token: ownerTok });
  const staff1 = onShift.data.on_shift.find((s) => s.name === "Stall Staff 1");
  const ghost = onShift.data.on_shift.find((s) => s.name?.includes("Unregistered"));
  check("staff01 shown ON SHIFT", Boolean(staff1));
  check("an unknown card is not on shift", !ghost);

  // 7. readings series endpoint
  const series = await req("/readings/recent?code=CART-01&channel=LPG_TANK", { token: ownerTok });
  check("readings series returned", series.data.readings.length >= 3);

  // 8. SSE stream tickets (JWTs must never ride query strings)
  const ticketRes = await req("/events/ticket", { method: "POST", token: ownerTok });
  check("stream ticket issued",
        ticketRes.status === 200 && typeof ticketRes.data?.ticket === "string");
  const ctrl = new AbortController();
  const streamRes = await fetch(`${BASE}/events?ticket=${ticketRes.data?.ticket}`, {
    headers: { Accept: "text/event-stream" },
    signal: ctrl.signal,
  }).catch(() => null);
  let firstChunk = "";
  if (streamRes?.body) {
    const reader = streamRes.body.getReader();
    const { value } = await reader.read().catch(() => ({}));
    firstChunk = Buffer.from(value ?? []).toString();
    ctrl.abort();
    await reader.cancel().catch(() => {});
  }
  check("stream opens on ticket",
        streamRes?.status === 200 &&
        (streamRes.headers.get("content-type") ?? "").includes("text/event-stream") &&
        firstChunk.includes("connected"));
  const jwtInQuery = await fetch(
    `${BASE}/events?token=${ownerTok}`,
    { headers: { Accept: "text/event-stream" }, signal: AbortSignal.timeout(8000) }
  ).catch(() => null);
  if (jwtInQuery?.body) await jwtInQuery.body.cancel().catch(() => {});
  check("JWT in query string rejected", jwtInQuery?.status === 401);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("Test crashed:", e.message);
  process.exit(1);
});
