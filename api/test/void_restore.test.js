// Pure-function tests for VOID stock-restore planning. No emulator needed:
// planVoidRestores never touches the database, which is the point of
// extracting it.
//
// The regression these lock down: PATCH /products/:id/rename rewrites
// ingredientMaps to the new name while past orders keep the old one, and
// matching is exact-string. An order sold before a rename used to match no
// map at all and the VOID returned { restored: [], warnings: [] } - a clean
// 200 that silently lost stock.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  mapsForOrderLine,
  planVoidRestores,
  oversellShortage,
} from "../src/services/inventory_rules.js";

// --- fixtures -------------------------------------------------------------

const invPouch = { id: 1, name: "Potato Pouch", stock: 10, threshold: 3, unit: "pcs" };
const invCheese = { id: 2, name: "Cheese Powder", stock: 20, threshold: 5, unit: "g" };
const invLpg = { id: 3, name: "LPG Tank", stock: 11, unit: "kg" };

// Cheese Fries has a generic map plus a flavor-specific override; the
// specific one must win per itemName.
const maps = [
  { productName: "Cheese Fries", flavor: "", itemName: "Potato Pouch", amountPerUnit: 1 },
  { productName: "Cheese Fries", flavor: "", itemName: "Cheese Powder", amountPerUnit: 15 },
  { productName: "Cheese Fries", flavor: "Cheese", itemName: "Cheese Powder", amountPerUnit: 20 },
  { productName: "Cheese Fries", flavor: "Sour Cream", itemName: "Cheese Powder", amountPerUnit: 18 },
];

// --- mapsForOrderLine -----------------------------------------------------

test("flavor-specific map beats the generic map for the same item", () => {
  const got = mapsForOrderLine(maps, "Cheese Fries", "Cheese");
  const cheese = got.find((m) => m.itemName === "Cheese Powder");
  assert.equal(cheese.amountPerUnit, 20, "Cheese override must win over generic 15");
});

test("a different flavor's override never leaks into this line", () => {
  const got = mapsForOrderLine(maps, "Cheese Fries", "Sour Cream");
  assert.equal(got.find((m) => m.itemName === "Cheese Powder").amountPerUnit, 18);
});

test("unknown product matches nothing", () => {
  assert.equal(mapsForOrderLine(maps, "Ghost Fries", "Cheese").length, 0);
});

// --- planVoidRestores: the happy paths ------------------------------------

test("multi-ingredient product restores every recipe line", () => {
  const { restores, warnings } = planVoidRestores(
    [{ productName: "Cheese Fries", flavor: "Cheese", qty: 2 }],
    maps,
    [invPouch, invCheese, invLpg],
  );
  assert.equal(warnings.length, 0, "a fully matched order must stay warning-free");
  assert.equal(restores.size, 2);
  // 1 pouch per unit x2, and the Cheese override 20g x2 (not the generic 15).
  assert.equal(restores.get(1).added, 2);
  assert.equal(restores.get(1).newStock, 12);
  assert.equal(restores.get(2).added, 40);
  assert.equal(restores.get(2).newStock, 60);
});

test("flavorless line falls back to the generic map", () => {
  const { restores, warnings } = planVoidRestores(
    [{ productName: "Cheese Fries", flavor: null, qty: 1 }],
    maps,
    [invPouch, invCheese],
  );
  assert.equal(warnings.length, 0);
  assert.equal(restores.get(2).added, 15, "generic 15g, not a flavor override");
});

test("the same ingredient across two lines accumulates instead of overwriting", () => {
  const { restores } = planVoidRestores(
    [
      { productName: "Cheese Fries", flavor: "Cheese", qty: 1 },
      { productName: "Cheese Fries", flavor: "Cheese", qty: 2 },
    ],
    maps,
    [invPouch, invCheese],
  );
  // (1 + 2) pouches and (20 + 40)g - the second pass must build on the first.
  assert.equal(restores.get(1).added, 3);
  assert.equal(restores.get(1).newStock, 13);
  assert.equal(restores.get(2).added, 60);
  assert.equal(restores.get(2).newStock, 80);
});

test("a missing inventory row warns and skips only that ingredient", () => {
  const { restores, warnings } = planVoidRestores(
    [{ productName: "Cheese Fries", flavor: "Cheese", qty: 1 }],
    maps,
    [invPouch], // no Cheese Powder row
  );
  assert.equal(restores.size, 1, "the resolvable ingredient still restores");
  assert.equal(restores.get(1).added, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no inventory row "Cheese Powder"/);
});

// --- planVoidRestores: the regression -------------------------------------

test("RENAMED product: no silent stock loss - warns instead of returning clean", () => {
  // The order was sold as "Cheese Fries"; the recipe is now keyed "Cheese Fries Supreme".
  const { restores, warnings } = planVoidRestores(
    [{ productName: "Cheese Fries", flavor: "Cheese", qty: 2 }],
    maps.map((m) => ({ ...m, productName: "Cheese Fries Supreme" })),
    [invPouch, invCheese],
  );
  assert.equal(restores.size, 0, "nothing can be restored once the recipe key is gone");
  assert.equal(
    warnings.length,
    1,
    "this is the bug: an empty warnings[] used to read as a successful void",
  );
  assert.match(warnings[0], /no recipe matched/);
  assert.match(warnings[0], /renamed/);
});

test("RENAMED flavour: generic fallback restores the WRONG amount, and now warns", () => {
  const renamedFlavorMaps = maps.map((m) =>
    m.flavor === "Cheese" ? { ...m, flavor: "Cheese Deluxe" } : m,
  );
  const { restores, warnings } = planVoidRestores(
    [{ productName: "Cheese Fries", flavor: "Cheese", qty: 1 }],
    renamedFlavorMaps,
    [invPouch, invCheese],
  );
  // The generic map survives, so the pouch restores fine.
  assert.equal(restores.get(1).added, 1);
  // But Cheese Powder now restores the generic 15g where the sale deducted
  // the flavour-specific 20g - a silent 5g drift per unit.
  assert.equal(restores.get(2).added, 15);
  assert.equal(
    warnings.length,
    1,
    "restoring the wrong amount must not pass silently",
  );
  assert.match(warnings[0], /only the generic recipe matched/);
  assert.match(warnings[0], /renamed/);
});

test("a genuinely flavourless recipe stays quiet (no false-positive warning)", () => {
  const flavorlessMaps = [
    { productName: "Plain Fries", flavor: "", itemName: "Potato Pouch", amountPerUnit: 1 },
  ];
  const { restores, warnings } = planVoidRestores(
    [{ productName: "Plain Fries", flavor: null, qty: 2 }],
    flavorlessMaps,
    [invPouch],
  );
  assert.equal(restores.get(1).added, 2);
  assert.equal(warnings.length, 0, "no flavour-specific maps exist, so nothing was renamed");
});

test("orphan warning names the exact product and flavor from the order", () => {
  const { warnings } = planVoidRestores(
    [{ productName: "Old Name", flavor: "Old Flavor", qty: 1 }],
    maps,
    [invPouch],
  );
  assert.match(warnings[0], /Old Name \/ Old Flavor/);
});

// --- symmetry with the sale side -----------------------------------------

test("restore is symmetric with the sale deduction", () => {
  const stock = 10;
  const qty = 3;
  const amountPerUnit = 1;
  const afterSale = stock - amountPerUnit * qty;
  const { restores } = planVoidRestores(
    [{ productName: "Cheese Fries", flavor: "Cheese", qty }],
    maps,
    [{ ...invPouch, stock: afterSale }],
  );
  assert.equal(restores.get(1).newStock, stock, "stock must come back exactly");
  assert.equal(oversellShortage(afterSale, amountPerUnit, qty), 0);
});

test("empty order list is a no-op with no warnings", () => {
  const { restores, warnings } = planVoidRestores([], maps, [invPouch]);
  assert.equal(restores.size, 0);
  assert.equal(warnings.length, 0);
});

test("null/undefined items do not throw", () => {
  assert.doesNotThrow(() => planVoidRestores(undefined, maps, [invPouch]));
});