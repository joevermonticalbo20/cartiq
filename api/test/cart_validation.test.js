// Cart name + address rules (Add Cart). Mirrors the web rules.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CART_ADDRESS_MAX,
  CART_ADDRESS_MIN,
  CART_NAME_MAX,
  CART_NAME_MIN,
  validateCartAddress,
  validateCartName,
} from "../src/services/cart_validation.js";

describe("cart name", () => {
  it("accepts letters, numbers, spaces, hyphen, apostrophe and ampersand", () => {
    for (const ok of [
      "Main Cart",
      "Cart 01",
      "Store-A",
      "Jones & Sons",
      "O'Brien",
      "A1&'-",
      "Carro  Ñoño",
    ]) {
      assert.equal(validateCartName(ok).ok, true, ok);
    }
  });

  it("refuses empty or whitespace-only names", () => {
    assert.equal(validateCartName("").ok, false);
    assert.equal(validateCartName("   ").ok, false);
    assert.equal(validateCartName("").error, "Cart Name is required.");
  });

  it("refuses names that are too short", () => {
    assert.equal(validateCartName("a").error, "Cart Name must be at least 2 characters.");
  });

  it("refuses names that are too long", () => {
    assert.equal(
      validateCartName("x".repeat(CART_NAME_MAX + 1)).error,
      "Cart Name must not exceed 50 characters.",
    );
    assert.equal(validateCartName("x".repeat(CART_NAME_MAX)).ok, true);
  });

  it("refuses numbers-only names", () => {
    assert.equal(validateCartName("123456").error, "Please enter a valid Cart Name.");
    assert.equal(validateCartName("- -").error, "Please enter a valid Cart Name.");
    assert.equal(validateCartName("&'-").error, "Please enter a valid Cart Name.");
  });

  it("refuses punctuation-only names", () => {
    assert.equal(validateCartName("@@@@@").error, "Please enter a valid Cart Name.");
    assert.equal(validateCartName("&a").ok, true);
  });

  it("refuses characters outside the allowed set (HTML is impossible)", () => {
    assert.equal(validateCartName("Cart @123").ok, false);
    assert.equal(validateCartName("<script>").ok, false);
    assert.equal(validateCartName("Main.Cart").ok, false);
    assert.equal(validateCartName("Cart_01").ok, false);
  });

  it("trims leading and trailing spaces", () => {
    const res = validateCartName("   Main Cart   ");
    assert.equal(res.ok, true);
    assert.equal(res.value, "Main Cart");
  });

  it("is case-insensitive - duplicates are allowed", () => {
    assert.equal(validateCartName("main cart").ok, true);
    assert.equal(validateCartName("MAIN CART").ok, true);
  });
});

describe("cart address", () => {
  it("accepts an empty address - it is optional", () => {
    assert.deepEqual(validateCartAddress(""), { ok: true, value: null });
    assert.deepEqual(validateCartAddress("   "), { ok: true, value: null });
    assert.deepEqual(validateCartAddress(null), { ok: true, value: null });
  });

  it("accepts a plausible address with #, commas and slashes", () => {
    for (const ok of [
      "Poblacion, Laguna",
      "Unit 2, Building #5",
      "123 Main Street",
      "Barangay 123, Sta. Cruz",
      "Blk 5 Lot 2, / corner of 5th / 3rd",
    ]) {
      assert.equal(validateCartAddress(ok).ok, true, ok);
    }
  });

  it("refuses addresses shorter than five characters", () => {
    assert.equal(
      validateCartAddress("abcd").error,
      "Address must be at least 5 characters.",
    );
    assert.equal(validateCartAddress("x".repeat(CART_ADDRESS_MIN)).ok, true);
  });

  it("refuses addresses longer than 150 characters", () => {
    assert.equal(
      validateCartAddress("x".repeat(CART_ADDRESS_MAX + 1)).error,
      "Address must not exceed 150 characters.",
    );
    assert.equal(validateCartAddress("x".repeat(CART_ADDRESS_MAX)).ok, true);
  });

  it("refuses punctuation-only addresses", () => {
    assert.equal(
      validateCartAddress("@@@@@@").error,
      "Please enter a valid address.",
    );
    assert.equal(
      validateCartAddress(",.'-###").error,
      "Please enter a valid address.",
    );
  });

  it("refuses characters outside the allowed set", () => {
    assert.equal(validateCartAddress("Main & Co").ok, false);
    assert.equal(validateCartAddress("123 Main (Bldg)").ok, false);
    assert.equal(validateCartAddress("<b>bold</b>").ok, false);
  });

  it("trims leading and trailing spaces", () => {
    const res = validateCartAddress("   Poblacion, Laguna   ");
    assert.equal(res.ok, true);
    assert.equal(res.value, "Poblacion, Laguna");
  });
});
