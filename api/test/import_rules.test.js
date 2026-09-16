import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  splitFlavorCell,
  validateProductRow,
  IMPORT_MAX_NAME_LEN,
  IMPORT_MAX_CATEGORY_LEN,
  IMPORT_MAX_PRICE,
  IMPORT_MAX_FLAVORS_PER_ROW,
  IMPORT_MAX_FLAVOR_LEN,
} from "../src/services/import_rules.js";

const valid = () => ({
  name: "Cheese Fries",
  category: "Fries",
  basePrice: 40,
  flavorNames: ["Cheese", "BBQ"],
});

describe("splitFlavorCell", () => {
  it("splits on ; and , and trims", () => {
    assert.deepEqual(splitFlavorCell("Cheese; BBQ,Sour Cream"), ["Cheese", "BBQ", "Sour Cream"]);
  });

  it("empty cell yields no flavors", () => {
    assert.deepEqual(splitFlavorCell(""), []);
    assert.deepEqual(splitFlavorCell(null), []);
  });
});

describe("validateProductRow", () => {
  it("accepts a normal row", () => {
    assert.equal(validateProductRow(valid()), null);
  });

  it("rejects a hostile 32k-char flavor cell via per-row flavor cap", () => {
    const giant = "x".repeat(32768);
    const row = { ...valid(), flavorNames: splitFlavorCell(giant) };
    // One giant token with no separator exceeds the flavor length cap.
    assert.match(validateProductRow(row), /flavor exceeds/);
    // Many names separated by ; exceed the per-row count cap.
    const many = Array.from({ length: IMPORT_MAX_FLAVORS_PER_ROW + 1 }, (_, i) => `F${i}`).join(";");
    assert.match(
      validateProductRow({ ...valid(), flavorNames: splitFlavorCell(many) }),
      /too many flavors/
    );
  });

  it("rejects over-long flavor, name, and category", () => {
    assert.match(
      validateProductRow({ ...valid(), flavorNames: ["y".repeat(IMPORT_MAX_FLAVOR_LEN + 1)] }),
      /flavor exceeds/
    );
    assert.match(
      validateProductRow({ ...valid(), name: "n".repeat(IMPORT_MAX_NAME_LEN + 1) }),
      /name exceeds/
    );
    assert.match(
      validateProductRow({ ...valid(), category: "c".repeat(IMPORT_MAX_CATEGORY_LEN + 1) }),
      /category exceeds/
    );
  });

  it("rejects non-positive and oversized prices", () => {
    assert.match(validateProductRow({ ...valid(), basePrice: 0 }), /invalid basePrice/);
    assert.match(validateProductRow({ ...valid(), basePrice: NaN }), /invalid basePrice/);
    assert.match(
      validateProductRow({ ...valid(), basePrice: IMPORT_MAX_PRICE + 1 }),
      /basePrice exceeds/
    );
  });

  it("accepts boundary values", () => {
    assert.equal(
      validateProductRow({
        name: "n".repeat(IMPORT_MAX_NAME_LEN),
        category: "c".repeat(IMPORT_MAX_CATEGORY_LEN),
        basePrice: IMPORT_MAX_PRICE,
        flavorNames: Array.from({ length: IMPORT_MAX_FLAVORS_PER_ROW }, (_, i) => `F${i}`),
      }),
      null
    );
  });
});
