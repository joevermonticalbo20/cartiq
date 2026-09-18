#!/usr/bin/env node
// Phase 8 integration test: cart provisioning + products catalog management.
// Requires: fresh db:seed; API listening (emulator-backed).
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
  const ownerLogin = await req("/auth/login", {
    method: "POST",
    body: { username: "owner", password: "owner123" },
  });
  const tok = ownerLogin.data?.token;
  check("owner login", ownerLogin.status === 200);
  const staffLogin = await req("/auth/login", {
    method: "POST",
    body: { username: "staff01", password: "staff123" },
  });
  const staffTok = staffLogin.data?.token;

  // ---- locations ----
  const missing = await req("/locations", {
    method: "POST", token: tok, body: { name: "No Code" },
  });
  check("add cart without code 400", missing.status === 400);
  const badCode = await req("/locations", {
    method: "POST", token: tok, body: { code: "bad code!", name: "Bad" },
  });
  check("add cart with bad code 400", badCode.status === 400);

  const created = await req("/locations", {
    method: "POST",
    token: tok,
    body: { code: "CART-04", name: "Test New Canteen", address: "Test Address" },
  });
  check("add CART-04 201", created.status === 201, `got ${created.status}`);
  check("starter inventory seeded (6 rows)", created.data?.items?.length === 6);
  check("device token issued once", typeof created.data?.deviceToken === "string" &&
    created.data.deviceToken.startsWith("dev-CART-04-"));
  check("device id derived", created.data?.device?.deviceId === "esp32-cart-04");
  const cartId = created.data?.location?.id;
  const devToken = created.data?.deviceToken;

  const dupe = await req("/locations", {
    method: "POST", token: tok, body: { code: "cart-04", name: "Dupe" },
  });
  check("duplicate code 409 (case-insensitive)", dupe.status === 409);

  const staffCreate = await req("/locations", {
    method: "POST", token: staffTok, body: { code: "CART-05", name: "Nope" },
  });
  check("staff cannot add cart 403", staffCreate.status === 403);
  const staffList = await req("/locations", { token: staffTok });
  check("staff cannot list carts 403", staffList.status === 403);

  const list = await req("/locations", { token: tok });
  const row = (list.data?.data ?? []).find((l) => l.code === "CART-04");
  check("CART-04 listed with counts", row?.itemCount === 6 && row?.status === "ACTIVE");

  const catalog = await req("/catalog", { token: tok });
  check("new cart in POS catalog", (catalog.data?.locations ?? []).some((l) => l.code === "CART-04"));

  // Issued device token really works (hits the fresh cart's inventory).
  const reading = await req("/iot/readings", {
    method: "POST", token: devToken,
    body: { readings: [{ channel: "LPG_TANK", kg: 10.5 }] },
  });
  check("issued device token accepted", reading.status === 201, `got ${reading.status}`);

  const off = await req(`/locations/${cartId}`, {
    method: "PATCH", token: tok, body: { status: "INACTIVE" },
  });
  check("deactivate 200", off.status === 200 && off.data?.location?.status === "INACTIVE");
  const catalog2 = await req("/catalog", { token: tok });
  check("inactive hidden from catalog", !(catalog2.data?.locations ?? []).some((l) => l.code === "CART-04"));
  const badStatus = await req(`/locations/${cartId}`, {
    method: "PATCH", token: tok, body: { status: "GONE" },
  });
  check("bad status 400", badStatus.status === 400);
  const backOn = await req(`/locations/${cartId}`, {
    method: "PATCH", token: tok, body: { status: "ACTIVE", name: "Test New Canteen v2" },
  });
  check("reactivate + rename", backOn.status === 200 &&
    backOn.data?.location?.status === "ACTIVE" &&
    backOn.data?.location?.name === "Test New Canteen v2");

  // ---- products ----
  const plist = await req("/products", { token: tok });
  const fries = (plist.data?.data ?? []).find((p) => p.name === "Flavored Fries");
  check("catalog product listed", Boolean(fries?.id));
  const cheeseId = fries?.flavors?.find((f) => f.name === "Cheese")?.id;

  const badProd = await req("/products", {
    method: "POST", token: tok, body: { name: "X", basePrice: -5 },
  });
  check("bad product 400", badProd.status === 400);
  const created2 = await req("/products", {
    method: "POST", token: tok,
    body: { name: "Test Nachos", category: "Snacks", basePrice: 55, flavorIds: cheeseId ? [cheeseId] : [] },
  });
  check("create product 201", created2.status === 201, `got ${created2.status}`);
  const nachoId = created2.data?.product?.id;
  const dupeProd = await req("/products", {
    method: "POST", token: tok, body: { name: "test nachos", basePrice: 60 },
  });
  check("duplicate product 409 (case-insensitive)", dupeProd.status === 409);
  const staffProd = await req("/products", {
    method: "POST", token: staffTok, body: { name: "Staff Snack", basePrice: 10 },
  });
  check("staff cannot create product 403", staffProd.status === 403);

  const priced = await req(`/products/${nachoId}`, {
    method: "PATCH", token: tok, body: { basePrice: 65 },
  });
  check("price update", priced.status === 200 && priced.data?.product?.basePrice === 65);
  const badPrice = await req(`/products/${nachoId}`, {
    method: "PATCH", token: tok, body: { basePrice: 0 },
  });
  check("bad price 400", badPrice.status === 400);

  const renamed = await req(`/products/${nachoId}`, {
    method: "PATCH", token: tok, body: {},
  });
  check("empty patch 400", renamed.status === 400);

  // Rename rewrites recipe rows (use the seeded product that has recipes).
  const friesId = fries?.id;
  const rename = await req(`/products/${friesId}/rename`, {
    method: "PATCH", token: tok, body: { name: "Test Fries Renamed" },
  });
  check("rename rewrites recipes", rename.status === 200 && rename.data?.mapsUpdated === 5,
    JSON.stringify(rename.data)?.slice(0, 120));
  const renameBack = await req(`/products/${friesId}/rename`, {
    method: "PATCH", token: tok, body: { name: "Flavored Fries" },
  });
  check("rename back restores recipes", renameBack.status === 200 && renameBack.data?.mapsUpdated === 5);

  const blocked = await req(`/products/${friesId}`, { method: "DELETE", token: tok });
  check("delete blocked when recipes exist 409", blocked.status === 409 &&
    blocked.data?.recipeRows === 5, `got ${blocked.status}`);

  const gone = await req(`/products/${nachoId}`, { method: "DELETE", token: tok });
  check("delete clean product 200", gone.status === 200 && gone.data?.deleted === true);
  const gone2 = await req(`/products/${nachoId}`, { method: "DELETE", token: tok });
  check("double delete 404", gone2.status === 404);

  const dupeFlavor = await req("/flavors", {
    method: "POST", token: tok, body: { name: "cheese" },
  });
  check("duplicate flavor 409 (case-insensitive)", dupeFlavor.status === 409);
  const newFlavor = await req("/flavors", {
    method: "POST", token: tok, body: { name: "Test Salt & Vinegar" },
  });
  check("create flavor 201", newFlavor.status === 201);
  const flavorList = await req("/flavors", { token: tok });
  check("flavor list includes new + seed flavors",
    (flavorList.data?.data ?? []).some((f) => f.name === "Test Salt & Vinegar") &&
    (flavorList.data?.data ?? []).some((f) => f.name === "Cheese"));

  // ---- per-flavor rows (by-flavor add) ----
  const byFlavor = await req("/products", {
    method: "POST", token: tok,
    body: {
      name: "Test Wasabi Fries", category: "Fries", basePrice: 60,
      flavors: [
        { name: "Test Wasabi", unitPrice: 70, recipes: [{ itemName: "Test Wasabi Powder", amountPerUnit: 0.04 }] },
        { flavorId: cheeseId },
      ],
    },
  });
  check("create product with per-flavor rows 201", byFlavor.status === 201 &&
    byFlavor.data?.flavorsCreated === 1 && byFlavor.data?.recipesCreated === 1,
    `got ${byFlavor.status} ${JSON.stringify(byFlavor.data)?.slice(0, 160)}`);
  const wasabiProdId = byFlavor.data?.product?.id;
  const wasabiFlavorId = (byFlavor.data?.product?.flavors ?? []).find((f) => f.name === "Test Wasabi")?.id;

  const badUnit = await req("/products", {
    method: "POST", token: tok,
    body: { name: "Test Bad Unit", basePrice: 10, flavors: [{ name: "Test Bad Flavor", unitPrice: -3 }] },
  });
  check("bad per-flavor unitPrice 400", badUnit.status === 400);
  const badRecipe = await req("/products", {
    method: "POST", token: tok,
    body: { name: "Test Bad Recipe", basePrice: 10, flavors: [{ name: "Test Bad Flavor 2", recipes: [{ itemName: "X", amountPerUnit: 0 }] }] },
  });
  check("bad recipe row 400", badRecipe.status === 400);

  const plist2 = await req("/products", { token: tok });
  const wf = (plist2.data?.data ?? []).find((p) => p.name === "Test Wasabi Fries");
  const wasabiRow = (wf?.flavors ?? []).find((f) => f.name === "Test Wasabi");
  const cheeseRow = (wf?.flavors ?? []).find((f) => f.name === "Cheese");
  check("per-flavor unitPrice + recipeCount served",
    wasabiRow?.unitPrice === 70 && wasabiRow?.recipeCount === 1 &&
    cheeseRow?.unitPrice === 60 && cheeseRow?.hasCustomPrice === false,
    JSON.stringify(wf?.flavors)?.slice(0, 200));
  check("per-flavor recipes served for Used-by mapping",
    (wasabiRow?.recipes ?? []).some((r) => r.itemName === "Test Wasabi Powder" && r.amountPerUnit === 0.04));

  const setPrice = await req(`/products/${wasabiProdId}`, {
    method: "PATCH", token: tok, body: { flavorPrices: { "Test Wasabi": 75 } },
  });
  check("per-flavor price override", setPrice.status === 200 &&
    setPrice.data?.product?.flavorPrices?.["Test Wasabi"] === 75, `got ${setPrice.status}`);

  const guardedRemove = await req(`/products/${wasabiProdId}`, {
    method: "PATCH", token: tok, body: { removeFlavorIds: [wasabiFlavorId] },
  });
  check("remove flavor with recipes blocked 409", guardedRemove.status === 409 &&
    (guardedRemove.data?.flavors ?? []).includes("Test Wasabi"), `got ${guardedRemove.status}`);

  const renameFlavor = await req(`/flavors/${wasabiFlavorId}`, {
    method: "PATCH", token: tok, body: { name: "Test Wasabi v2" },
  });
  check("flavor rename rewrites maps + prices", renameFlavor.status === 200 &&
    renameFlavor.data?.mapsUpdated === 1 && renameFlavor.data?.pricesRewritten === 1,
    `got ${renameFlavor.status} ${JSON.stringify(renameFlavor.data)?.slice(0, 140)}`);

  const plist3 = await req("/products", { token: tok });
  const wf3 = (plist3.data?.data ?? []).find((p) => p.name === "Test Wasabi Fries");
  const renamedRow = (wf3?.flavors ?? []).find((f) => f.name === "Test Wasabi v2");
  check("renamed flavor keeps price + recipe", renamedRow?.unitPrice === 75 && renamedRow?.recipeCount === 1);

  const rmRecipes = await req(`/products/${wasabiProdId}`, {
    method: "PATCH", token: tok,
    body: { removeRecipes: [{ flavor: "Test Wasabi v2", itemName: "Test Wasabi Powder" }] },
  });
  check("remove recipe rows 200", rmRecipes.status === 200, `got ${rmRecipes.status}`);
  const unlinked = await req(`/products/${wasabiProdId}`, {
    method: "PATCH", token: tok, body: { removeFlavorIds: [wasabiFlavorId] },
  });
  check("remove flavor after rows deleted 200", unlinked.status === 200, `got ${unlinked.status}`);

  const cheeseFlavor = (flavorList.data?.data ?? []).find((f) => f.name === "Cheese");
  const blockedFlavor = await req(`/flavors/${cheeseFlavor?.id}`, { method: "DELETE", token: tok });
  check("delete linked flavor blocked 409", blockedFlavor.status === 409, `got ${blockedFlavor.status}`);

  const delFlavor = await req(`/flavors/${wasabiFlavorId}`, { method: "DELETE", token: tok });
  check("delete unlinked flavor 200", delFlavor.status === 200 && delFlavor.data?.deleted === true);
  const delProd = await req(`/products/${wasabiProdId}`, { method: "DELETE", token: tok });
  check("delete per-flavor test product 200", delProd.status === 200 && delProd.data?.deleted === true);

  // ---- product <-> inventory connection ----
  const names = await req("/inventory/names", { token: tok });
  check("inventory names list", names.status === 200 &&
    (names.data?.data ?? []).some((n) => n.name === "Cheese Powder"),
    `got ${names.status}`);
  const staffNames = await req("/inventory/names", { token: staffTok });
  check("staff can read inventory names 200", staffNames.status === 200);

  // Recipe item with no stock row anywhere: created (warn, don't block),
  // reported as unmatched, and visible as missingItems on the product.
  const ghost = await req("/products", {
    method: "POST", token: tok,
    body: {
      name: "Test Ghost Fries", basePrice: 10,
      flavors: [{ name: "Test Ghost", recipes: [{ itemName: "No Such Item XYZ", amountPerUnit: 1 }] }],
    },
  });
  check("recipe with unknown item still 201", ghost.status === 201, `got ${ghost.status}`);
  check("unmatchedItems names the ghost row",
    (ghost.data?.unmatchedItems ?? []).some((u) => u.itemName === "No Such Item XYZ"));
  const ghostId = ghost.data?.product?.id;
  const plist4 = await req("/products", { token: tok });
  const ghostRow = (plist4.data?.data ?? []).find((p) => p.name === "Test Ghost Fries");
  const ghostFlavor = (ghostRow?.flavors ?? []).find((f) => f.name === "Test Ghost");
  check("missingItems flags the ghost row",
    (ghostFlavor?.missingItems ?? []).includes("No Such Item XYZ"),
    JSON.stringify(ghostFlavor)?.slice(0, 200));
  const ghostFlavorId = ghostFlavor?.id;
  // Cleanup: remove recipe row, unlink + delete flavor, delete product.
  await req(`/products/${ghostId}`, {
    method: "PATCH", token: tok,
    body: { removeRecipes: [{ flavor: "Test Ghost", itemName: "No Such Item XYZ" }] },
  });
  await req(`/products/${ghostId}`, {
    method: "PATCH", token: tok, body: { removeFlavorIds: [ghostFlavorId] },
  });
  await req(`/flavors/${ghostFlavorId}`, { method: "DELETE", token: tok });
  const ghostGone = await req(`/products/${ghostId}`, { method: "DELETE", token: tok });
  check("ghost product cleanup 200", ghostGone.status === 200 && ghostGone.data?.deleted === true);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("Test crashed:", e.message);
  process.exit(1);
});
