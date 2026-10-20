import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  POUCH_PER_UNIT,
  FROZEN_PACKS_PER_UNIT,
  POWDER_KG_PER_UNIT,
  genericRecipeRows,
  flavorRecipeRows,
  houseRecipeFor,
} from "../src/services/recipe_defaults.js";
import { recipeAvailability } from "../src/services/inventory_rules.js";

describe("recipe_defaults (house convention)", () => {
  it("deducts 1 pouch per unit", () => {
    assert.equal(POUCH_PER_UNIT, 1);
    assert.deepEqual(genericRecipeRows(), [
      { itemName: "Pouches", amountPerUnit: 1 },
      { itemName: "Fries (frozen packs)", amountPerUnit: FROZEN_PACKS_PER_UNIT },
    ]);
  });

  it("seasons with 15 g powder per serving (0.015 kg)", () => {
    assert.equal(POWDER_KG_PER_UNIT, 0.015);
    for (const [flavor, powder] of [
      ["Cheese", "Cheese Powder"],
      ["Sour Cream", "Sour Cream Powder"],
      ["BBQ", "BBQ Powder"],
      ["Sinigang", "Sinigang Powder"],
    ]) {
      const { rows, unknownFlavor } = flavorRecipeRows(flavor);
      assert.equal(unknownFlavor, false);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].itemName, powder);
      assert.equal(rows[0].amountPerUnit, 0.015);
    }
  });

  it("matches flavors case-insensitively", () => {
    assert.equal(flavorRecipeRows("  cheese ").rows[0].itemName, "Cheese Powder");
    assert.equal(flavorRecipeRows("BBQ").rows[0].itemName, "BBQ Powder");
  });

  it("reports unknown flavors instead of guessing", () => {
    const { rows, unknownFlavor } = flavorRecipeRows("Mystery Spice");
    assert.equal(unknownFlavor, true);
    assert.deepEqual(rows, []);
  });

  it("house recipe combines generics + powder", () => {
    const { rows, unknownFlavor } = houseRecipeFor("Cheese");
    assert.equal(unknownFlavor, false);
    assert.deepEqual(
      rows.map((r) => r.itemName),
      ["Pouches", "Fries (frozen packs)", "Cheese Powder"]
    );
  });

  it("computes available servings from resolved generic and flavor recipes", () => {
    const maps = [
      { productName: "Fries", flavor: "", itemName: "Pouches", amountPerUnit: 1 },
      { productName: "Fries", flavor: "", itemName: "Fries (frozen packs)", amountPerUnit: 0.05 },
      { productName: "Fries", flavor: "Cheese", itemName: "Cheese Powder", amountPerUnit: 0.015 },
    ];
    const inventory = new Map([
      ["Pouches", { stock: 20 }],
      ["Fries (frozen packs)", { stock: 1 }],
      ["Cheese Powder", { stock: 0.09 }],
    ]);
    assert.deepEqual(recipeAvailability("Fries", "Cheese", maps, inventory), {
      isAvailable: true,
      availableServings: 6,
      limitingIngredient: "Cheese Powder",
    });
  });

  it("uses house defaults when no recipe map exists and reports depleted stock", () => {
    const inventory = new Map([
      ["Pouches", { stock: 20 }],
      ["Fries (frozen packs)", { stock: 1 }],
      ["BBQ Powder", { stock: 0 }],
    ]);
    assert.deepEqual(recipeAvailability("Fries", "BBQ", [], inventory), {
      isAvailable: false,
      availableServings: 0,
      limitingIngredient: "BBQ Powder",
    });
  });
});
