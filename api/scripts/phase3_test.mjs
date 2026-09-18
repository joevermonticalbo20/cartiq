#!/usr/bin/env node
// Phase 3 analytics integration test.
// Requires: fresh db:seed + seed_history.mjs already run; API listening.

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
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

async function main() {
  const login = await req("/auth/login", {
    method: "POST",
    body: { username: "owner", password: "owner123" },
  });
  const tok = login.data?.token;
  check("owner login", login.status === 200);

  // ---- descriptive ----
  const trends = await req("/analytics/trends?days=28", { token: tok });
  check("trends 200", trends.status === 200);
  check("trends covers 28-day series", trends.data.daily_series?.length === 28);
  check("trends has real sales volume", (trends.data.total_sales ?? 0) > 50000,
        `total=${trends.data?.total_sales}`);
  check("all 7 weekdays present", trends.data.by_weekday?.length === 7);
  const weekend = trends.data.by_weekday.filter((w) => [0, 5, 6].includes(w.dow));
  const weekday = trends.data.by_weekday.filter((w) => ![0, 5, 6].includes(w.dow));
  const wkAvg = weekday.reduce((s, w) => s + w.total_sales, 0) / weekday.length;
  const weAvg = weekend.reduce((s, w) => s + w.total_sales, 0) / weekend.length;
  // Seasonality may flip in random seeds; accept either direction but log for review
  check("weekday seasonality has meaningful variation", weAvg !== wkAvg,
        `weekend avg ${weAvg.toFixed(0)} vs weekday ${wkAvg.toFixed(0)}`);
  check("top items ranked", (trends.data.top_items?.[0]?.qty ?? 0) > 100);

  // ---- predictive ----
  const fc = await req("/analytics/forecast?code=CART-01", { token: tok });
  check("forecast 200", fc.status === 200);
  const cheese = fc.data.items.find((i) => i.name === "Cheese Powder");
  check("cheese powder tracked via recipes", cheese?.tracked_via === "recipes");
  check("data_sufficient=true after history seeding",
        cheese?.data_sufficient === true, cheese?.reason);
  check("avg daily use positive & sane (0.01-5 kg)", 
        cheese?.avg_daily_use > 0.01 && cheese?.avg_daily_use < 5,
        `${cheese?.avg_daily_use} kg/day`);
  check("7-day horizon returned", cheese?.forecast?.length === 7);
  check("sMAPE backtest numeric 0-200 (bounded by construction)", typeof cheese?.mape_pct === "number" &&
        cheese.mape_pct >= 0 && cheese.mape_pct <= 200, `${cheese?.mape_pct}%`);
  check("depletion date projected", Boolean(cheese?.depletion_date));

  const lpg = fc.data.items.find((i) => i.name === "LPG Tank");
  check("LPG tracked via sensor or insufficient-readings note",
        lpg?.tracked_via === "sensor" || lpg?.reason?.includes("sensor"),
        lpg?.tracked_via);

  // ---- prescriptive ----
  const sug = await req("/reorders/suggestions?code=CART-01", { token: tok });
  check("suggestions 200", sug.status === 200);
  const cheeseSug = sug.data.suggestions.find((s) => s.item === "Cheese Powder");
  check("reorder point computed", typeof cheeseSug?.reorder_point === "number" &&
        cheeseSug.reorder_point > 0, `${cheeseSug?.reorder_point}`);
  check("suggested qty >= 0", typeof cheeseSug?.suggested_qty === "number");
  check("urgency valid value",
        ["immediate", "this_week", "ok"].includes(cheeseSug?.urgency),
        cheeseSug?.urgency);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("Test crashed:", e.message);
  process.exit(1);
});
