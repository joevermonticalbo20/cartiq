// Unit tests for the shared input-validation policy
// (api/src/services/validation.js). DoH is stubbed: validateRecoveryEmail
// performs DNS MX lookups, and these tests must not depend on the network.
import test from "node:test";
import assert from "node:assert/strict";

import {
  cleanName,
  validateName,
  validateReason,
  validateUsername,
  validateRecoveryEmail,
  isDisposableEmail,
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

test("validateUsername normalizes and enforces the pattern", () => {
  assert.deepEqual(validateUsername("  Staff_01 "), { ok: true, value: "staff_01" });
  for (const bad of ["", "ab", "staff 01", "staff!", ".staff", "staff.", "staff..01", "a".repeat(31)]) {
    assert.equal(validateUsername(bad).ok, false, bad);
  }
});

test("validateReason requires 3..500 characters", () => {
  assert.equal(validateReason("ok reason").ok, true);
  assert.equal(validateReason("ab").ok, false);
  assert.equal(validateReason("x".repeat(501)).ok, false);
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

test("validateRecoveryEmail normalizes case", async () => {
  const restore = stubDns(true);
  try {
    const out = await validateRecoveryEmail("  User@Gmail.COM  ");
    assert.deepEqual(out, { ok: true, email: "user@gmail.com" });
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
