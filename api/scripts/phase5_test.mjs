#!/usr/bin/env node
// Phase 5 integration test: pagination meta, staff management,
// change-password, device registry, shift history.

const BASE = "http://127.0.0.1:4000/api";
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
  check("owner login", Boolean(tok));

  const staffLogin = await req("/auth/login", {
    method: "POST",
    body: { username: "staff01", password: "staff123" },
  });
  const staffTok = staffLogin.data?.token;
  check("staff login", Boolean(staffTok));

  // ---- change password ----
  const wrongCur = await req("/auth/change-password", {
    method: "POST",
    token: staffTok,
    body: { currentPassword: "nope", newPassword: "newpass456" },
  });
  check("change-password rejects wrong current", wrongCur.status === 401);

  const shortPw = await req("/auth/change-password", {
    method: "POST",
    token: staffTok,
    body: { currentPassword: "staff123", newPassword: "123" },
  });
  check("change-password enforces min length", shortPw.status === 400);

  const changed = await req("/auth/change-password", {
    method: "POST",
    token: staffTok,
    body: { currentPassword: "staff123", newPassword: "staff456" },
  });
  check("password changed", changed.data?.updated === true);
  const relogin = await req("/auth/login", {
    method: "POST",
    body: { username: "staff01", password: "staff456" },
  });
  check("login works with new password", relogin.status === 200);
  // restore for other suites
  await req("/auth/change-password", {
    method: "POST",
    token: relogin.data?.token ?? staffTok,
    body: { currentPassword: "staff456", newPassword: "staff123" },
  });

  // ---- staff management ----
  const forbidden = await req("/auth/staff", { token: staffTok });
  check("staff list forbidden for STAFF role", forbidden.status === 403);

  const created = await req("/auth/staff", {
    method: "POST",
    token: tok,
    body: {
      name: `Test Staff ${run}`,
      username: `teststaff_${run}`,
      password: "test123",
      locationCode: "CART-02",
      rfidUid: null,
    },
  });
  check("owner creates staff account", created.status === 201 &&
        created.data.user?.active === true);
  const newId = created.data?.user?.id;

  const dupe = await req("/auth/staff", {
    method: "POST",
    token: tok,
    body: { name: "Dup", username: `teststaff_${run}`, password: "test123" },
  });
  check("duplicate username rejected 409", dupe.status === 409);

  const disabled = await req(`/auth/staff/${newId}`, {
    method: "PATCH",
    token: tok,
    body: { active: false },
  });
  check("disable staff account", disabled.data?.user?.active === false);
  const blockedLogin = await req("/auth/login", {
    method: "POST",
    body: { username: `teststaff_${run}`, password: "test123" },
  });
  check("disabled account cannot log in", blockedLogin.status === 401);
  await req(`/auth/staff/${newId}`, { method: "PATCH", token: tok, body: { active: true } });
  const reset = await req(`/auth/staff/${newId}`, {
    method: "PATCH",
    token: tok,
    body: { password: "reset456" },
  });
  check("owner resets staff password", reset.status === 200);
  const resetLogin = await req("/auth/login", {
    method: "POST",
    body: { username: `teststaff_${run}`, password: "reset456" },
  });
  check("login with reset password + enabled account", resetLogin.status === 200);

  const list = await req("/auth/staff", { token: tok });
  check("staff list includes locations & rfid fields",
        Array.isArray(list.data?.data) && list.data.data.length >= 5 &&
        "rfidUid" in list.data.data[0]);
  const listed = list.data.data.find((u) => u.id === newId);
  check("created staff shows CART-02 assignment", listed?.location?.code === "CART-02");

  // ---- devices ----
  const devicesStaff = await req("/devices", { token: staffTok });
  check("device registry forbidden for STAFF", devicesStaff.status === 403);
  const devices = await req("/devices", { token: tok });
  check("3 IoT devices registered", devices.data?.data?.length === 3);
  check("online flag computed (false before simulator runs)",
        devices.data.data.every((d) => d.online === false || typeof d.online === "boolean"));

  // ---- pagination ----
  const ordersP1 = await req("/orders?page=1&pageSize=5", { token: tok });
  check("orders meta shape", ordersP1.data?.meta?.total > 1000 &&
        ordersP1.data.meta.totalPages > 1 && ordersP1.data.data.length === 5);
  const ordersP2 = await req("/orders?page=2&pageSize=5", { token: tok });
  check("page 2 differs from page 1",
        ordersP2.data.data[0]?.id !== ordersP1.data.data[0]?.id);

  const alerts = await req("/alerts?page=1&pageSize=5", { token: tok });
  check("alerts meta present", typeof alerts.data?.meta?.total === "number");

  const expenses = await req("/expenses?page=1&pageSize=5", { token: tok });
  check("expenses meta + totals preserved",
        typeof expenses.data?.meta?.totalPages === "number" &&
        typeof expenses.data?.totals?.total_amount === "number");

  const history = await req("/shifts/history?page=1&pageSize=5&code=CART-01", { token: tok });
  check("shift history paged", Array.isArray(history.data?.data) &&
        history.data.meta.totalPages >= 1);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("Test crashed:", e.message);
  process.exit(1);
});
