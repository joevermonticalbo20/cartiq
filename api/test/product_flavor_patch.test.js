import { describe, it } from "node:test";
import assert from "node:assert/strict";

// The handler's guard logic lives in applyFullFlavorList (Express
// routes/products.js). node:test has no module mocking, so this test
// loads the routes module once with a query-suffixed URL — making its
// `db` import a fresh module instance — and then replaces the exported
// `db` object's flavor/ingredientMap handles with an in-memory sandbox.
// The Edge function (supabase/functions/api/index.ts) mirrors the same
// logic; parity is verified by scripts/check_api_parity.mjs.
import { db as prisma } from "../src/firestore.js";

// --- in-memory sandbox -------------------------------------------------
function makeSandbox({ ingredientMaps = [] } = {}) {
  const flavors = [
    { id: 1, name: "Cheese" },
    { id: 2, name: "BBQ" },
    { id: 3, name: "Sour Cream" },
  ];
  let nextId = 4;
  const counts = { findMany: 0, create: 0 };
  const db = {
    flavor: {
      findMany: async () => {
        counts.findMany += 1;
        return flavors.map((f) => ({ ...f }));
      },
      create: async ({ data }) => {
        counts.create += 1;
        const f = { id: nextId++, name: data.name };
        flavors.push(f);
        return { ...f };
      },
    },
    ingredientMap: {
      findMany: async (args) => {
        const where = args?.where ?? {};
        return ingredientMaps
          .filter((m) => (where.productName === undefined || m.productName === where.productName))
          .map((m) => ({ ...m }));
      },
    },
    bumpCatalogVersion: async () => ({ version: 0, updatedAt: null }),
    runTransaction: async (fn) => fn({ ...db, txn: {} }),
  };
  return { db, flavors, counts, reset({ ingredientMaps: maps = [] } = {}) {
    flavors.length = 0;
    flavors.push({ id: 1, name: "Cheese" }, { id: 2, name: "BBQ" }, { id: 3, name: "Sour Cream" });
    nextId = 4;
    ingredientMaps.length = 0;
    ingredientMaps.push(...maps);
    counts.findMany = 0;
    counts.create = 0;
    return db;
  } };
}

const sandbox = makeSandbox();
const original = { flavor: prisma.flavor, ingredientMap: prisma.ingredientMap };

const mod = await import("../src/routes/products.js?test=flavor-patch");
const applyFullFlavorList = mod.applyFullFlavorList;
assert.equal(typeof applyFullFlavorList, "function", "routes module must export applyFullFlavorList");

// Point the (fresh) routes module instance at the sandbox. Its `db`
// import is a distinct module object from the test's own import, so we
// patch the exported singleton it shares.
prisma.flavor = sandbox.db.flavor;
prisma.ingredientMap = sandbox.db.ingredientMap;

const existing = {
  name: "Fries",
  flavorIds: [1, 2],
  flavors: [
    { id: 1, name: "Cheese" },
    { id: 2, name: "BBQ" },
  ],
};

function reset({ ingredientMaps = [] } = {}) {
  sandbox.reset({ ingredientMaps });
}

describe("applyFullFlavorList (PATCH /products/:id flavors)", () => {
  it("adds a new flavor via name and keeps existing links", async () => {
    reset();
    const out = await applyFullFlavorList({
      existing,
      flavors: [{ name: "Cheese" }, { name: "BBQ" }, { name: "Sour Cream" }],
      removeRecipes: [],
    });
    assert.equal(out.flavorsChanged, 1);
    assert.deepEqual(new Set(out.nextIds), new Set([1, 2, 3]));
  });

  it("creates an unknown flavor name, like POST", async () => {
    reset();
    const out = await applyFullFlavorList({
      existing,
      flavors: [{ name: "Cheese" }, { name: "Sinigang" }],
      removeRecipes: [],
    });
    assert.equal(out.flavorsChanged, 2); // one added + one removed
    assert.deepEqual(new Set(out.nextIds), new Set([1, 4]));
    assert.deepEqual(out.removedNames, ["BBQ"]);
  });

  it("blocks removal while recipe rows still reference the flavor (409 guard)", async () => {
    reset({ ingredientMaps: [{ productName: "Fries", flavor: "BBQ", itemName: "BBQ Powder" }] });
    const out = await applyFullFlavorList({
      existing,
      flavors: [{ name: "Cheese" }],
      removeRecipes: [],
    });
    assert.equal(out.error, "guarded");
    assert.deepEqual(out.guarded, ["BBQ"]);
  });

  it("allows removal when the same request deletes the referencing rows first", async () => {
    reset({ ingredientMaps: [{ productName: "Fries", flavor: "BBQ", itemName: "BBQ Powder" }] });
    const out = await applyFullFlavorList({
      existing,
      flavors: [{ name: "Cheese" }],
      removeRecipes: [{ flavor: "BBQ", itemName: "BBQ Powder" }],
    });
    assert.equal(out.flavorsChanged, 1);
    assert.deepEqual(out.nextIds, [1]);
  });

  it("still blocks when the cleanup leaves a row behind", async () => {
    reset({
      ingredientMaps: [
        { productName: "Fries", flavor: "BBQ", itemName: "BBQ Powder" },
        { productName: "Fries", flavor: "BBQ", itemName: "Pouches" },
      ],
    });
    const out = await applyFullFlavorList({
      existing,
      flavors: [{ name: "Cheese" }],
      removeRecipes: [{ flavor: "BBQ", itemName: "BBQ Powder" }],
    });
    assert.equal(out.error, "guarded");
    assert.deepEqual(out.guarded, ["BBQ"]);
  });

  it("rejects duplicates and oversized lists", async () => {
    reset();
    const dup = await applyFullFlavorList({
      existing,
      flavors: [{ name: "Cheese" }, { name: "cheese" }],
      removeRecipes: [],
    });
    assert.equal(dup.flavorsChanged, 1); // "BBQ" unlinked, "Cheese" deduped
    assert.deepEqual(new Set(dup.nextIds), new Set([1]));
    assert.deepEqual(dup.removedNames, ["BBQ"]);

    const many = await applyFullFlavorList({
      existing,
      flavors: Array.from({ length: 21 }, (_, i) => ({ name: `F${i} Flavor` })),
      removeRecipes: [],
    });
    assert.equal(many.error, "at most 20 flavors per product");

    const blank = await applyFullFlavorList({
      existing,
      flavors: [{ name: "  " }],
      removeRecipes: [],
    });
    assert.equal(blank.error, "Flavor name is required.");
  });

  it("returns no change for an identical list", async () => {
    reset();
    const out = await applyFullFlavorList({
      existing,
      flavors: [{ name: "BBQ" }, { name: "Cheese" }],
      removeRecipes: [],
    });
    assert.equal(out.flavorsChanged, 0);
    assert.deepEqual(out.removedNames, []);
  });

  it("rejects a non-array flavors body", async () => {
    reset();
    const out = await applyFullFlavorList({ existing, flavors: "Cheese", removeRecipes: [] });
    assert.equal(out.error, "flavors must be an array");
  });

  it("rejects unknown numeric ids", async () => {
    reset();
    const out = await applyFullFlavorList({
      existing,
      flavors: [{ id: 9999 }],
      removeRecipes: [],
    });
    assert.equal(out.error, "One or more flavors not found");
  });
});
