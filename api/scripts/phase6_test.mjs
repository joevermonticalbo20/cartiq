#!/usr/bin/env node
// Phase 6 (CartIQ 2.1) test: expense categories end-to-end.

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
  const login = await req("/auth/login", {
    method: "POST",
    body: { username: "owner", password: "owner123" },
  });
  const tok = login.data?.token;
  check("owner login", Boolean(tok));

  // default category when omitted
  const def = await req("/expenses", {
    method: "POST",
    token: tok,
    body: { vendor: "Default Cat Probe", amount: 100 },
  });
  check("omitted category defaults to Supplies",
        def.data?.expense?.category === "Supplies");

  // each fixed category accepted (one representative + full list via GET meta)
  for (const cat of ["LPG/Gas", "Maintenance", "Fees/Rent", "Other"]) {
    const r = await req("/expenses", {
      method: "POST",
      token: tok,
      body: { vendor: `Probe ${cat}`, amount: 50, category: cat, locationCode: "CART-01" },
    });
    check(`category "${cat}" accepted`, r.data?.expense?.category === cat);
  }

  const invalid = await req("/expenses", {
    method: "POST",
    token: tok,
    body: { vendor: "Bad Cat", amount: 10, category: "Shenanigans" },
  });
  check("invalid category rejected 400", invalid.status === 400);

  // filter returns only that category
  const filtered = await req("/expenses?category=LPG/Gas&page=1&pageSize=50", { token: tok });
  check("category filter isolates rows",
        filtered.data.data.length > 0 &&
        filtered.data.data.every((e) => e.category === "LPG/Gas"));

  // by_category breakdown ignores the category filter and sums correctly
  const lpgTotal = filtered.data.totals.total_amount;
  const unfiltered = await req("/expenses?page=1&pageSize=1", { token: tok });
  const breakdown = Object.fromEntries(
    unfiltered.data.by_category.map((c) => [c.category, c.total])
  );
  check("by_category includes all five buckets",
        unfiltered.data.by_category.length === 5);
  check("LPG/Gas bucket matches filtered total",
        Math.abs((breakdown["LPG/Gas"] ?? -1) - lpgTotal) < 0.01,
        `${breakdown["LPG/Gas"]} vs ${lpgTotal}`);
  check("Supplies bucket at least the default-created amount",
        (breakdown["Supplies"] ?? 0) >= 100);

  // PATCH can reclassify
  const patched = await req(`/expenses/${def.data.expense.id}`, {
    method: "PATCH",
    token: tok,
    body: { category: "Other" },
  });
  check("PATCH reclassifies category", patched.data?.expense?.category === "Other");
  const badPatch = await req(`/expenses/${def.data.expense.id}`, {
    method: "PATCH",
    token: tok,
    body: { category: "Nope" },
  });
  check("PATCH rejects invalid category", badPatch.status === 400);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("Test crashed:", e.message);
  process.exit(1);
});
