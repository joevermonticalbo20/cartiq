// Unit tests for the shared input-validation policy
// (api/src/services/validation.js). DoH is stubbed: validateRecoveryEmail
// performs DNS MX lookups, and these tests must not depend on the network.
import test from "node:test";
import assert from "node:assert/strict";

import {
  cleanName,
  validateName,
  validateReason,
  validateRecoveryEmail,
  isDisposableEmail,
  validateTextLine,
  validateVendorName,
} from "../src/services/validation.js";

test("cleanName collapses whitespace and strips control characters", () => {
  assert.equal(cleanName("  Joever   Monticalbo\t Jr  "), "Joever Monticalbo Jr");
  assert.equal(cleanName("Cu\u0000stomer"), "Customer");
});

test("validateName accepts normal names", () => {
  assert.equal(validateName("María-Clara Reyes Jr.").ok, true);
  assert.equal(validateName("Pota Fries - Medium").ok, true);
  assert.equal(validateName("Fries (frozen packs)").ok, true);
  assert.equal(validateName("XL 40").ok, true);
});

test("validateName rejects empty, too-short, digits-only and dirty names", () => {
  assert.equal(validateName("").ok, false);
  assert.equal(validateName("A").ok, false);
  assert.equal(validateName("12345").ok, false); // digits only: fewer than 2 letters
  assert.equal(validateName("Customer<script>").ok, false); // < not in allowlist
  assert.equal(validateName("Customer🎉").ok, false); // emoji not allowed
  const long = validateName("a".repeat(101));
  assert.equal(long.ok, true); // auto-truncates to 100 instead of rejecting
  assert.equal(long.value.length, 100);
});

test("validateReason requires 3..500 characters", () => {
  assert.equal(validateReason("ok reason").ok, true);
  assert.equal(validateReason("ab").ok, false);
  assert.equal(validateReason("x".repeat(501)).ok, false);
});

test("validateTextLine enforces min and max with label-specific messages", () => {
  assert.equal(validateTextLine("", { label: "Category", min: 3, max: 30 }).error, "Category is required.");
  assert.equal(validateTextLine("AB", { label: "Category", min: 3, max: 30 }).error, "Category must be at least 3 characters.");
  assert.equal(
    validateTextLine("ABCDEFGHIJKLMNOPQRSTUVWXYZ1234", { label: "Flavor name", min: 3, max: 20 }).error,
    "Flavor name must not exceed 20 characters."
  );
  assert.equal(validateTextLine("AB".repeat(16), { label: "Recipe item", min: 3, max: 30 }).ok, false);
  assert.equal(validateTextLine("Cheese Powder", { label: "Recipe item", min: 3, max: 30 }).ok, true);
  assert.equal(validateTextLine("  Cheese   Powder  ", { label: "Recipe item", min: 3, max: 30 }).value, "Cheese Powder");
  assert.equal(validateTextLine("   ", { label: "Category", min: 3, max: 30 }).error, "Category is required.");
});

test("validateVendorName enforces 3..30 chars and single spacing", () => {
  assert.equal(validateVendorName("").error, "Vendor is required.");
  assert.equal(validateVendorName("AB").error, "Vendor must be at least 3 characters.");
  assert.equal(validateVendorName("A".repeat(31)).error, "Vendor must not exceed 30 characters.");
  assert.deepEqual(validateVendorName("ABC  Supplier"), { ok: true, value: "ABC Supplier" });
  assert.equal(validateVendorName("Juan Store").ok, true);
});

test("isDisposableEmail blocks known throwaway domains", () => {
  assert.equal(isDisposableEmail("user@mailinator.com"), true);
  assert.equal(isDisposableEmail("user@sub.mailinator.com"), true);
  assert.equal(isDisposableEmail("user@gmail.com"), false);
});

function stubDns(answer) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => (answer ? { Answer: [{ data: "10 mx." }] } : {}),
  });
  return () => { globalThis.fetch = original; };
}

test("validateRecoveryEmail refuses uppercase anywhere in the address", async () => {
  // The owner's rule: "Gmail.com" with a capital G is not accepted. Whitespace
  // is trimmed, the address is stored lowercased, but case errors are refused.
  const restore = stubDns(true);
  try {
    const out = await validateRecoveryEmail("  User@Gmail.COM  ");
    assert.equal(out.ok, false);
    assert.equal(out.error, "Please enter a valid email address.");
    assert.deepEqual(await validateRecoveryEmail("  USER@GMAIL.COM  "), {
      ok: false,
      email: "user@gmail.com",
      error: "Please enter a valid email address.",
    });
    assert.deepEqual(await validateRecoveryEmail("  user@gmail.com  "), {
      ok: true,
      email: "user@gmail.com",
    });
  } finally {
    restore();
  }
});

test("validateRecoveryEmail rejects placeholders", async () => {
  const out = await validateRecoveryEmail("user@cartiq.local");
  assert.equal(out.ok, false);
  assert.match(out.error, /placeholder/);
});

test("validateRecoveryEmail fails closed on nonexistent domains", async () => {
  const restore = stubDns(false);
  try {
    const out = await validateRecoveryEmail("user@nonexistent-domain-xyz-123.invalid");
    assert.equal(out.ok, false);
    assert.match(out.error, /does not exist/);
  } finally {
    restore();
  }
});
