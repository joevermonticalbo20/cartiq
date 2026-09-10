#!/usr/bin/env node
// Phase 7 integration test: owner order VOID workflow + staff alert ack.
// Requires API on http://127.0.0.1:4000/api with seeded data.

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
    console.log(`FAIL  ${name} ${detail ? `- ${detail}` : ""}`);
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
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function main() {
  const run = Date.now().toString(36).slice(-5);

  const ownerLogin = await req("/auth/login", {
    method: "POST",
    body: { username: "owner", password: "owner123" },
  });
  const tok = ownerLogin.data?.token;
  const ownerId = ownerLogin.data?.user?.id;
  check("owner login", Boolean(tok));

  const staffLogin = await req("/auth/login", {
    method: "POST",
    body: { username: "staff01", password: "staff123" },
  });
  const staffTok = staffLogin.data?.token;
  const staffId = staffLogin.data?.user?.id;
  check("staff login", Boolean(staffTok));

  // ---- owner VOID workflow ----
  const created = await req("/orders", {
    method: "POST",
    token: tok,
    body: {
      clientRef: `phase7-void-${run}`,
      locationCode: "CART-01",
      items: [{ productName: "Flavored Fries", qty: 1, unitPrice: 40 }],
    },
  });
  const orderId = created.data?.order?.id;
  check("setup order created", created.status === 201 && typeof orderId === "number");

  const staffVoid = await req(`/orders/${orderId}`, {
    method: "PATCH", token: staffTok, body: { status: "VOID" },
  });
  check("staff cannot VOID", staffVoid.status === 403);

  const anonVoid = await req(`/orders/${orderId}`, {
    method: "PATCH", body: { status: "VOID" },
  });
  check("unauthenticated VOID rejected", anonVoid.status === 401);

  const badStatus = await req(`/orders/${orderId}`, {
    method: "PATCH", token: tok, body: { status: "REFUNDED" },
  });
  check("invalid status rejected", badStatus.status === 400);

  const voided = await req(`/orders/${orderId}`, {
    method: "PATCH", token: tok,
    body: { status: "VOID", reason: "phase7 mis-tap" },
  });
  check("owner can VOID",
        voided.status === 200 && voided.data?.order?.status === "VOID");
  check("VOID records actor",
        voided.data?.order?.voidedBy === ownerId &&
        typeof voided.data?.order?.voidedAt === "string");

  const revoid = await req(`/orders/${orderId}`, {
    method: "PATCH", token: tok, body: { status: "VOID" },
  });
  check("double VOID rejected", revoid.status === 400);

  const missing = await req("/orders/999999999", {
    method: "PATCH", token: tok, body: { status: "VOID" },
  });
  check("VOID unknown order 404", missing.status === 404);

  const history = await req("/orders?page=1&pageSize=100", { token: tok });
  const seen = (history.data?.data ?? []).find((o) => o.id === orderId);
  check("voided order preserved in history",
        seen?.status === "VOID" && typeof seen?.total === "number");

  // ---- staff alert acknowledgement ----
  const uid = `H7-${run}`;
  await req("/shifts", {
    method: "POST", token: DEV_TOKEN,
    body: { events: [{ staff_uid: uid, event: "IN" }] },
  });
  const alerts = await req("/alerts?page=1&pageSize=50", { token: tok });
  const target = (alerts.data?.data ?? []).find(
    (a) => a.type === "UNKNOWN_CARD" && (a.message ?? "").includes(uid)
  );
  check("UNKNOWN_CARD alert raised for test tap", Boolean(target?.id));

  const anonAck = await req(`/alerts/${target?.id}/ack`, { method: "PATCH" });
  check("unauthenticated ack rejected", anonAck.status === 401);

  const ack = await req(`/alerts/${target?.id}/ack`, {
    method: "PATCH", token: staffTok,
  });
  check("staff can acknowledge",
        ack.status === 200 && ack.data?.alert?.ackedBy === staffId &&
        typeof ack.data?.alert?.ackedAt === "string");
  check("ack is not resolve (isRead untouched)",
        ack.data?.alert?.isRead === false);

  const resolve = await req(`/alerts/${target?.id}/read`, {
    method: "PATCH", token: tok,
  });
  check("owner resolve path intact", resolve.data?.alert?.isRead === true);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("Test crashed:", e.message);
  process.exit(1);
});
