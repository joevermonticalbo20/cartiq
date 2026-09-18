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
});
