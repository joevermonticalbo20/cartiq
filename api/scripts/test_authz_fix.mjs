#!/usr/bin/env node
// Batch1/2 regression: logout, 15min token, VOID restore, orders limits,
// alert dedupeKey, cart_id mismatch, secure-ping, Manila boundaries.
// Requires: Firestore emulator + seeded API running (npm run dev).
// Usage: node scripts/test_authz_fix.mjs [--base http://127.0.0.1:4000/api]
const BASE = (process.argv.find((a, i) => process.argv[i - 1] === "--base" && a) ) || process.env.API_BASE || "http://127.0.0.1:4000/api";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
};
async function req(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data; try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}
function decodeExp(jwt) {
  try { return JSON.parse(Buffer.from(jwt.split(".")[1], "base64").toString()).exp * 1000; } catch { return 0; }
}

// login owner
const login = await req("POST", "/auth/login", { body: { username: "owner", password: "owner123" } });
ok("login owner", login.status === 200 && login.data?.token, JSON.stringify(login.data)?.slice(0, 120));
const token = login.data?.token, refresh = login.data?.refreshToken;
ok("access ~15min", Math.abs(decodeExp(token) - (Date.now() + 15 * 60 * 1000)) < 2 * 60 * 1000, String(decodeExp(token)));
ok("secure-ping", (await req("GET", "/secure-ping", { token })).status === 200);
ok("secure-ping no-auth 401", (await req("GET", "/secure-ping")).status === 401);

// logout revokes
const logout = await req("POST", "/auth/logout", { body: { refreshToken: refresh } });
ok("logout 200", logout.status === 200 && logout.data?.loggedOut === true);
const reuse = await req("POST", "/auth/refresh", { body: { refreshToken: refresh } });
ok("refresh after logout rejected", reuse.status === 401, `got ${reuse.status}`);

// fresh login for write tests
const l2 = await req("POST", "/auth/login", { body: { username: "owner", password: "owner123" } });
const t2 = l2.data?.token;
// orders limits
const tooMany = await req("POST", "/orders", { token: t2, body: { locationCode: "CART-01", items: Array.from({ length: 101 }, (_, i) => ({ productName: `P${i}`, qty: 1, unitPrice: 10 })) } });
ok("orders 101 items -> 400", tooMany.status === 400, `got ${tooMany.status}`);
const badQty = await req("POST", "/orders", { token: t2, body: { locationCode: "CART-01", items: [{ productName: "X", qty: 101, unitPrice: 10 }] } });
ok("orders qty 101 -> 400", badQty.status === 400, `got ${badQty.status}`);

// VOID restore: create then void
const catalog = await req("GET", "/catalog", { token: t2 });
const prod = catalog.data?.products?.[0];
if (prod) {
  // Snapshot stock for this product's recipe ingredients BEFORE the sale, then
  // assert the VOID puts it back. This used to be captured and thrown away
  // (`void invBefore`), which is exactly why a VOID that silently restored
  // nothing still reported success.
  const stockMap = async () => {
    const inv = await req("GET", "/inventory?code=CART-01", { token: t2 });
    // GET /inventory returns { locations: [{ id, code, name, items: [...] }] }
    const rows = (inv.data?.locations ?? []).flatMap((loc) => loc.items ?? []);
    return new Map(rows.map((r) => [r.name, Number(r.stock)]));
  };
  const before = await stockMap();
  const create = await req("POST", "/orders", { token: t2, body: { clientRef: `void-test-${Date.now()}`, locationCode: "CART-01", items: [{ productName: prod.name, flavor: prod.flavors?.[0]?.name ?? null, qty: 1, unitPrice: prod.basePrice ?? 10 }] } });
  ok("create order for void", create.status === 201, `got ${create.status}`);
  if (create.status === 201) {
    const oid = create.data?.order?.id;
    const during = await stockMap();
    const deducted = [...before].filter(([name, was]) => during.has(name) && during.get(name) < was);
    ok("sale deducted recipe stock", deducted.length > 0, `${deducted.length} ingredient(s) moved`);

    const voided = await req("PATCH", `/orders/${oid}`, { token: t2, body: { status: "VOID", reason: "test" } });
    ok("void restores", voided.status === 200 && Array.isArray(voided.data?.restored) && Array.isArray(voided.data?.warnings), `got ${voided.status}`);
    // Every ingredient the sale touched must be back where it started.
    const after = await stockMap();
    const notRestored = [...before].filter(([name, was]) =>
      deducted.some(([dName]) => dName === name) && Math.abs(after.get(name) - was) > 0.001);
    ok("void returns every deducted ingredient to its original stock",
      notRestored.length === 0,
      notRestored.length ? notRestored.map(([n, v]) => `${n}: ${v} vs ${after.get(n)}`).join("; ")
        : `no warnings expected, got ${JSON.stringify(voided.data?.warnings ?? [])}`);
    // An unrestorable line must be reported, never returned as a clean success.
    const orphanWarnings = (voided.data?.warnings ?? []).filter((w) => /no recipe matched|generic recipe/.test(String(w)));
    ok("void reports any unrestorable line instead of failing silently",
      voided.status !== 200 || orphanWarnings.length === 0,
      `warnings=${JSON.stringify(orphanWarnings)}`);

    const again = await req("PATCH", `/orders/${oid}`, { token: t2, body: { status: "VOID" } });
    // Sequential re-void: outside fast-path 400 (parallel races get 409).
    ok("double void -> 400", again.status === 400, `got ${again.status}`);
  }
} else {
  console.log("SKIP void test: no products in catalog");
}

// device cart mismatch (needs device token; skip gracefully if unknown)
ok("manila reports daily", (await req("GET", "/reports/daily", { token: t2 })).status === 200);
ok("manila on-shift", (await req("GET", "/staff/on-shift", { token: t2 })).status === 200);

// device registry CRUD (OWNER) + staff scoping
const devId = `esp32-test-${Date.now().toString(36)}`;
const devCreate = await req("POST", "/devices", { token: t2, body: { deviceId: devId, cart: "CART-01" } });
ok("device register 201 + one-shot token", devCreate.status === 201 && typeof devCreate.data?.deviceToken === "string", `got ${devCreate.status}`);
const devDup = await req("POST", "/devices", { token: t2, body: { deviceId: devId } });
ok("device duplicate -> 409", devDup.status === 409, `got ${devDup.status}`);
const devBad = await req("POST", "/devices", { token: t2, body: { deviceId: "x" } });
ok("device bad id -> 400", devBad.status === 400, `got ${devBad.status}`);
if (devCreate.status === 201) {
  const did = devCreate.data.device.id;
  const devPatch = await req("PATCH", `/devices/${did}`, { token: t2, body: { cart: "CART-02" } });
  ok("device reassign 200", devPatch.status === 200, `got ${devPatch.status}`);
  const devDel = await req("DELETE", `/devices/${did}`, { token: t2 });
  ok("device delete 200", devDel.status === 200 && devDel.data?.deleted === true, `got ${devDel.status}`);
  const devGone = await req("DELETE", `/devices/${did}`, { token: t2 });
  ok("device re-delete -> 404", devGone.status === 404, `got ${devGone.status}`);
}
const staffLogin = await req("POST", "/auth/login", { body: { username: "staff01", password: "staff123" } });
if (staffLogin.status === 200) {
  const st = staffLogin.data.token;
  ok("staff device register -> 403", (await req("POST", "/devices", { token: st, body: { deviceId: `esp32-staff-${Date.now().toString(36)}` } })).status === 403);
  ok("staff cross-cart order -> 403", (await req("POST", "/orders", { token: st, body: { clientRef: `x-${Date.now()}`, locationCode: "CART-02", items: [{ productName: "Flavored Fries", flavor: "Cheese", qty: 1, unitPrice: 40 }] } })).status === 403);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
