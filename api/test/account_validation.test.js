// Account holders (staff/admin): full name + username rules.
//
// The owner's spec, mirrored in:
//   - api/src/services/validation.js       (Express)
//   - supabase/functions/api/index.ts     (Edge)
//   - web/src/utils/text.js               (browser)
//
// Keep all four in sync.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  FULL_NAME_MAX,
  cleanFullName,
  validateFullName,
  validateAccountUsername,
} from "../src/services/validation.js";

describe("full name", () => {
  it("accepts ordinary and accented/Filipino names", () => {
    for (const ok of [
      "Juan Dela Cruz",
      "Maria Clara Santos",
      "Anne-Marie Lopez",
      "O'Connor Reyes",
      "José Peña",
      "Ñoño Santos",
      "Joever Monticalbo",
      "A B", // two letters separated by a space is a legal shape
    ]) {
      assert.equal(validateFullName(ok).ok, true, ok);
    }
  });

  it("refuses empty or whitespace-only input", () => {
    assert.deepEqual(validateFullName(""), {
      ok: false,
      value: "",
      error: "Full name is required.",
    });
    assert.equal(validateFullName("    ").error, "Full name is required.");
  });

  it("enforces the 2-character minimum", () => {
    assert.equal(
      validateFullName("J").error,
      "Full name must be at least 2 characters."
    );
    assert.equal(validateFullName("Jo").ok, true);
  });

  it("enforces the 50-character maximum", () => {
    const atLimit = validateFullName("x".repeat(FULL_NAME_MAX));
    assert.equal(atLimit.ok, true);
    assert.equal(
      validateFullName("x".repeat(FULL_NAME_MAX + 1)).error,
      "Full name must not exceed 50 characters."
    );
  });

  it("refuses numbers, including numbers mixed into a name", () => {
    assert.equal(
      validateFullName("Juan123").error,
      "Full name cannot contain numbers or special characters."
    );
    assert.equal(
      validateFullName("123456").error,
      "Full name cannot contain numbers or special characters."
    );
    assert.equal(validateFullName("Maria 2nd").ok, false);
  });

  it("refuses special characters outside spaces/hyphens/apostrophes", () => {
    for (const bad of ["@@@@@", "!!!!!!!!!!", "Juan@Dela", "<script>alert(1)</script>", "Juan_Dela", "Anne Marie!"]) {
      const res = validateFullName(bad);
      assert.equal(res.ok, false, bad);
      assert.equal(
        res.error,
        "Full name cannot contain numbers or special characters.",
        bad
      );
    }
  });

  it("requires at least one letter even when the punctuation itself is allowed", () => {
    // "-" and "'" pass the allow-set, but there is no letter in there.
    assert.equal(
      validateFullName("-'-'-'").error,
      "Please enter a valid full name."
    );
  });

  it("trims and collapses internal whitespace", () => {
    assert.equal(cleanFullName("   Juan   Dela   Cruz   "), "Juan Dela Cruz");
    const res = validateFullName("   Maria Clara Santos   ");
    assert.equal(res.ok, true);
    assert.equal(res.value, "Maria Clara Santos");
  });

  it("allows duplicate names - only the username must be unique", () => {
    assert.equal(validateFullName("Juan Dela Cruz").value, "Juan Dela Cruz");
    assert.equal(validateFullName("Juan Dela Cruz").value, "Juan Dela Cruz");
  });

  it("collapses a newline into a normal space", () => {
    // Whitespace is normalised, not treated as markup or a separator hack.
    assert.deepEqual(validateFullName("Ju\nan"), { ok: true, value: "Ju an" });
  });

  it("rejects control characters instead of smuggling them through", () => {
    assert.equal(validateFullName("Ju\u0000an").ok, false);
    assert.equal(validateFullName("Ju\u0007an").ok, false);
  });
});

describe("username", () => {
  it("accepts the documented valid examples", () => {
    for (const ok of ["juandelacruz", "juan123", "staff_001", "admin2026"]) {
      assert.equal(validateAccountUsername(ok).ok, true, ok);
    }
  });

  it("lowercases before validating and storing", () => {
    assert.deepEqual(validateAccountUsername("  Staff_01 "), {
      ok: true,
      value: "staff_01",
    });
    assert.deepEqual(validateAccountUsername("JUANDELACRUZ"), {
      ok: true,
      value: "juandelacruz",
    });
  });

  it("refuses empty or whitespace-only input", () => {
    assert.deepEqual(validateAccountUsername(""), {
      ok: false,
      value: "",
      error: "Username is required.",
    });
    assert.equal(validateAccountUsername("    ").error, "Username is required.");
  });

  it("enforces the 4-30 character range", () => {
    assert.equal(validateAccountUsername("abc").error, "Username must be between 4 and 30 characters.");
    assert.equal(
      validateAccountUsername("a".repeat(31)).error,
      "Username must be between 4 and 30 characters."
    );
    assert.equal(validateAccountUsername("abcd").ok, true);
    assert.equal(validateAccountUsername("a".repeat(30)).ok, true);
  });

  it("must start with a letter", () => {
    assert.equal(
      validateAccountUsername("12345678").error,
      "Username must start with a letter."
    );
    assert.equal(
      validateAccountUsername("_staff01").error,
      "Username must start with a letter."
    );
    assert.equal(validateAccountUsername("1abc").error, "Username must start with a letter.");
  });

  it("refuses spaces and special characters", () => {
    assert.equal(
      validateAccountUsername("joever@123").error,
      "Username cannot contain spaces or special characters."
    );
    assert.equal(
      validateAccountUsername("staff 001").error,
      "Username cannot contain spaces or special characters."
    );
    for (const bad of ["@@@@@@@", "staff!01", "staff#01", "staff&01", "staff*01"]) {
      assert.equal(
        validateAccountUsername(bad).error,
        "Username cannot contain spaces or special characters.",
        bad
      );
    }
  });

  it("allows underscores inside the name", () => {
    assert.equal(validateAccountUsername("staff_001").ok, true);
    assert.equal(validateAccountUsername("a_b_c_d").ok, true);
  });
});
