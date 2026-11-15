// Unit-aware inventory rules and classification - the five supported units.
// Mirrors web/src/utils/inventory.js (keep both in sync).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  UNIT_OPTIONS as INVENTORY_UNITS,
  INVENTORY_CATEGORIES,
  isSupportedUnit,
  isWholeUnit,
  normalizeUnit,
  parseQtyForUnit,
  validateInventoryItemName,
  siblingNameClash,
  stockStatusOf,
} from "../src/services/inventory_validation.js";

describe("inventory units", () => {
  it("exactly the five spec units are supported", () => {
    assert.deepEqual(INVENTORY_UNITS, ["pcs", "kg", "g", "packs", "liters"]);
    for (const u of ["pcs", "kg", "g", "packs", "liters"]) {
      assert.equal(isSupportedUnit(u), true);
      assert.equal(normalizeUnit(u), u);
    }
    for (const bad of ["boxes", "Pcs ", "KG", "liter", "", "undefined", "ml"]) {
      // Case and whitespace are normalised, so only unknown names fail.
      if (bad === "Pcs " || bad === "KG") continue;
      assert.equal(isSupportedUnit(bad), false, bad);
      assert.equal(normalizeUnit(bad), null, bad);
    }
  });

  it("pcs and packs require whole numbers", () => {
    assert.equal(isWholeUnit("pcs"), true);
    assert.equal(isWholeUnit("packs"), true);
    assert.equal(isWholeUnit("kg"), false);
    assert.equal(parseQtyForUnit("10", "pcs").ok, true);
    assert.equal(parseQtyForUnit("10.5", "pcs").ok, false);
    assert.equal(parseQtyForUnit("10.5", "packs").ok, false);
  });

  it("kg/g/liters accept up to 2 decimals", () => {
    assert.equal(parseQtyForUnit("0.25", "kg").value, 0.25);
    assert.equal(parseQtyForUnit("1.25", "kg").value, 1.25);
    assert.equal(parseQtyForUnit("0.5", "g").value, 0.5);
    assert.equal(parseQtyForUnit("100.25", "g").value, 100.25);
    assert.equal(parseQtyForUnit("5.75", "liters").value, 5.75);
    assert.equal(parseQtyForUnit("1.234", "kg").ok, false);
  });

  it("refuses negatives, NaN, scientific notation, multiple dots, Infinity", () => {
    for (const bad of ["-1", "abc", "1e5", "1E5", "NaN", "Infinity", "1.2.3", ".", "1..2"]) {
      assert.equal(parseQtyForUnit(bad, "kg").ok, false, bad);
      assert.equal(parseQtyForUnit(bad, "pcs").ok, false, bad);
    }
  });

  it("allows zero and refuses over the cap", () => {
    assert.equal(parseQtyForUnit("0", "pcs").value, 0);
    assert.equal(parseQtyForUnit("0.00", "kg").value, 0);
    assert.equal(parseQtyForUnit("99999", "pcs").value, 99999);
    assert.equal(parseQtyForUnit("100000", "pcs").ok, false);
    assert.equal(parseQtyForUnit("99999.99", "kg").value, 99999.99);
    assert.equal(parseQtyForUnit("100000.00", "kg").ok, false);
  });
});

describe("inventory status classification", () => {
  it("Out of Stock when stock is zero, even at zero threshold", () => {
    assert.equal(stockStatusOf(0, 0), "out");
    assert.equal(stockStatusOf(0, 5), "out");
  });

  it("Low Stock when stock > 0 and <= threshold", () => {
    assert.equal(stockStatusOf(5, 5), "low");
    assert.equal(stockStatusOf(2, 5), "low");
    assert.equal(stockStatusOf(10, 15), "low");
    assert.equal(stockStatusOf(2, 2), "low");
  });

  it("OK when stock > threshold", () => {
    assert.equal(stockStatusOf(10, 2), "ok");
    assert.equal(stockStatusOf(1, 0), "ok");
    assert.equal(stockStatusOf(100, 99), "ok");
  });

  it("all five units follow the same classification", () => {
    for (const unit of INVENTORY_UNITS) {
      const v = unit === "packs" || unit === "pcs" ? 5 : 5.25;
      const t = unit === "packs" || unit === "pcs" ? 5 : 5.25;
      assert.equal(stockStatusOf(v, t), "low", unit);
      assert.equal(stockStatusOf(0, t), "out", unit);
      assert.equal(stockStatusOf(v + 1, t), "ok", unit);
    }
  });
});

describe("inventory item name", () => {
  it("accepts normal names incl. its charset", () => {
    for (const ok of [
      "Cheese Powder",
      "Fries (frozen packs)",
      "Pouches, Medium",
      "100% натуральной",
      "Sinigang-flavored powder",
      "Notes 25.5 (pack)",
      "XL", // two letters, fine
    ]) {
      assert.equal(validateInventoryItemName(ok).ok, true, ok);
    }
  });

  it("refuses empty and whitespace-only names", () => {
    assert.equal(validateInventoryItemName("").error, "Item name is required.");
    assert.equal(validateInventoryItemName("   ").error, "Item name is required.");
  });

  it("refuses a one-character name", () => {
    assert.equal(
      validateInventoryItemName("A").error,
      "Item name must contain at least 2 characters."
    );
  });

  it("refuses a name over 100 characters", () => {
    assert.equal(
      validateInventoryItemName("a".repeat(101)).error,
      "Item name must not exceed 100 characters."
    );
    assert.equal(validateInventoryItemName("a".repeat(100)).ok, true);
  });

  it("refuses HTML and special characters outside the allowed set", () => {
    for (const bad of ["<script>", "Name @ World", "Item & Co", "Item_name", "A\\B", "a$b"]) {
      assert.equal(validateInventoryItemName(bad).ok, false, bad);
      assert.equal(
        validateInventoryItemName(bad).error,
        "Please enter a valid item name.",
        bad
      );
    }
  });
});

describe("case-insensitive duplicate check", () => {
  const siblings = [{ name: "Cheese Powder" }, { name: "Fries (frozen packs)" }];

  it("finds the clash regardless of case", () => {
    assert.equal(siblingNameClash(siblings, "cheese powder")?.name, "Cheese Powder");
    assert.equal(siblingNameClash(siblings, "CHEESE POWDER")?.name, "Cheese Powder");
    assert.equal(siblingNameClash(siblings, "FRIES (FROZEN PACKS)")?.name, "Fries (frozen packs)");
  });

  it("allows a different item in the same cart", () => {
    assert.equal(siblingNameClash(siblings, "Other item"), null);
  });

  it("case and variations never match nothing on the exact same item", () => {
    assert.notEqual(siblingNameClash(siblings, "cheese powder"), null);
    assert.notEqual(siblingNameClash(siblings, "CHEESE POWDER"), null);
  });
});
