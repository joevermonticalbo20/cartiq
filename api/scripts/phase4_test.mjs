#!/usr/bin/env node
// Phase 4 integration test: OCR/manual expenses + Excel export/import.
// Requires API listening and owner credentials seeded.

import ExcelJS from "exceljs";

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
  return { status: res.status, res, data: await res.json().catch(() => null) };
}

async function main() {
  // Unique-per-run product names keep this test idempotent on any database.
  const run = Date.now().toString(36).slice(-5);
  const P1 = `Test Dip Sauce ${run}`;
  const P2 = `Test Bucket ${run}`;

  const login = await req("/auth/login", {
    method: "POST",
    body: { username: "owner", password: "owner123" },
  });
  const tok = login.data.token;
  const H = { Authorization: `Bearer ${tok}` };

  // ---- expenses ----
  const ocr = await req("/expenses", {
    method: "POST",
    token: tok,
    body: {
      vendor: "XYZ Gas Station",
      locationCode: "CART-01",
      amount: 620,
      source: "OCR",
      note: "LPG refill - parsed from receipt",
      lines: [{ item: "LPG 11kg refill", qty: 1, price: 620 }],
    },
  });
  check("OCR expense created", ocr.status === 201 && ocr.data.expense.source === "OCR");
  check("receipt lines stored as JSON",
        Array.isArray(ocr.data.expense.lines) && ocr.data.expense.lines[0].item === "LPG 11kg refill");

  const bad = await req("/expenses", {
    method: "POST",
    token: tok,
    body: { vendor: "No Amount" },
  });
  check("expense without amount rejected 400", bad.status === 400);

  const list = await req("/expenses?code=CART-01&limit=10", { token: tok });
  check("expense list + totals", list.data.totals.count >= 1 &&
        list.data.totals.total_amount >= 620);

  const patched = await req(`/expenses/${ocr.data.expense.id}`, {
    method: "PATCH",
    token: tok,
    body: { amount: 650 },
  });
  check("OCR correction via PATCH", patched.data.expense?.amount === 650);

  // ---- export ----
  const salesExport = await fetch(`${BASE}/export/sales`, { headers: H });
  const buf = Buffer.from(await salesExport.arrayBuffer());
  check("sales xlsx downloads", salesExport.status === 200 &&
        salesExport.headers.get("content-type").includes("spreadsheetml"));
  check("xlsx is a valid zip container (PK magic)", buf.length > 1000 &&
        buf[0] === 0x50 && buf[1] === 0x4b);
  check("export filename header", (salesExport.headers.get("content-disposition") ?? "")
        .includes("cartiq-sales"));

  const noAuth = await fetch(`${BASE}/export/inventory`);
  check("export requires auth", noAuth.status === 401);

  for (const ds of ["inventory", "expenses", "shifts"]) {
    const r = await fetch(`${BASE}/export/${ds}`, { headers: H });
    check(`${ds} xlsx exports`, r.status === 200);
  }

  // ---- import: build a test workbook ----
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Products");
  sheet.addRow(["name", "category", "basePrice", "flavors"]);
  sheet.addRow([P1, "Add-ons", 25, "Cheese"]);
  sheet.addRow([P2, "Fries", 95, "Cheese;BBQ;Sour Cream"]);
  sheet.addRow(["", "Fries", 30]);                    // error: missing name
  sheet.addRow(["Free Item", "Fries", "abc"]);        // error: bad price
  const importBuffer = Buffer.from(await wb.xlsx.writeBuffer());

  async function upload(dryRun) {
    const form = new FormData();
    form.append("file", new Blob([importBuffer]), "products.xlsx");
    const res = await fetch(`${BASE}/import/products?dry_run=${dryRun}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}` },
      body: form,
    });
    return { status: res.status, data: await res.json() };
  }

  const preview = await upload(true);
  check("import dry-run previews without commit",
        preview.status === 200 && preview.data.committed === false);
  check("row counts correct (4 rows, 2 valid)", preview.data.rows_total === 4 &&
        preview.data.valid_count === 2, JSON.stringify(preview.data));
  check("bad name row flagged", preview.data.errors.some((e) => e.reason.includes("missing name")));
  check("bad price row flagged", preview.data.errors.some((e) => e.reason.includes("invalid basePrice")));

  const commitBad = await upload(false); // same file still has errors
  check("commit blocked while errors exist", commitBad.data.committed !== true);

  // clean workbook: only the two valid products
  const wb2 = new ExcelJS.Workbook();
  const s2 = wb2.addWorksheet("Products");
  s2.addRow(["name", "category", "basePrice", "flavors"]);
  s2.addRow([P1, "Add-ons", 25, "Cheese"]);
  s2.addRow([P2, "Fries", 95, "Cheese;BBQ;Sour Cream"]);
  const cleanBuffer = Buffer.from(await wb2.xlsx.writeBuffer());

  const form2 = new FormData();
  form2.append("file", new Blob([cleanBuffer]), "products.xlsx");
  const commitOk = await fetch(`${BASE}/import/products?dry_run=false`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}` },
    body: form2,
  });
  const commitData = await commitOk.json();
  check("clean file commits 2 products", commitData.committed === true && commitData.valid_count === 2);

  const catalog = await req("/catalog", { token: tok });
  const names = catalog.data.products.map((p) => p.name);
  check("new products live in catalog", names.includes(P1) && names.includes(P2));
  const bucket = catalog.data.products.find((p) => p.name === P2);
  check("new flavors auto-created and linked", bucket.flavors.length === 3);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("Test crashed:", e.message);
  process.exit(1);
});
