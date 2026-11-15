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
      "Aaron", // two a's is fine
      "Yyan", // two y's is fine
    ]) {
      assert.equal(validateFullName(ok).ok, true, ok);
    }
  });

  it("refuses a run of three or more identical letters anywhere in the name", () => {
    for (const bad of ["AAa", "aaaa", "AAaaAAaa aaaAA", "BBBB Boots", "Joseeee"]) {
      assert.equal(validateFullName(bad).ok, false, bad);
      assert.equal(validateFullName(bad).error, "Please enter a valid full name.");
    }
  });

  it("requires at least TWO letters - a name with one letter-only is refused", () => {
    assert.equal(validateFullName("A").error, "Full name must be at least 2 characters.");
    assert.equal(validateFullName("--").error, "Please enter a valid full name.");
    assert.equal(validateFullName("-Juan").ok, true);
    assert.equal(validateFullName("-Juan!").error, "Full name cannot contain numbers or special characters.");
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

  it("enforces the 30-character maximum", () => {
    const atLimit = validateFullName("x".repeat(FULL_NAME_MAX));
    assert.equal(atLimit.ok, false); // same-letter run
    const varied = "abcdefg ABCDEFG ".repeat(2).slice(0, FULL_NAME_MAX);
    assert.equal(validateFullName(varied).ok, true);
    assert.equal(
      validateFullName("x".repeat(FULL_NAME_MAX + 1)).error,
      "Full name must not exceed 30 characters."
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

  it("enforces the 4-20 character range", () => {
    assert.equal(validateAccountUsername("abc").error, "Username must be between 4 and 20 characters.");
    assert.equal(
      validateAccountUsername("a".repeat(21)).error,
      "Username must be between 4 and 20 characters."
    );
    assert.equal(validateAccountUsername("abcd").ok, true);
    assert.equal(validateAccountUsername("a".repeat(20)).ok, true);
  });

  it("accepts letters, digits, underscores and periods - nothing else", () => {
    for (const ok of ["a.b_c1", "staff_001", "admin2026", "juandelacruz"]) {
      assert.equal(validateAccountUsername(ok).ok, true, ok);
    }
    for (const bad of ["a_b c", "a@b_c", "a#b", "a-b"]) {
      assert.equal(validateAccountUsername(bad).ok, false, bad);
    }
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
    assert.equal(
      validateAccountUsername(".staff01").error,
      "Username must start with a letter."
    );
    assert.equal(validateAccountUsername("1abc").error, "Username must start with a letter.");
  });

  it("refuses consecutive underscores or periods (same or mixed)", () => {
    for (const bad of ["ab__cd", "ab..cd", "ab_.cd", "ab._cd"]) {
      assert.equal(
        validateAccountUsername(bad).error,
        "Username cannot contain consecutive underscores or periods.",
        bad
      );
    }
    for (const ok of ["a_b.c", "a.b_c", "a_b_c"]) {
      assert.equal(validateAccountUsername(ok).ok, true, ok);
    }
  });

  it("must end with a letter or a number", () => {
    for (const bad of ["staff_", "staff."]) {
      assert.equal(
        validateAccountUsername(bad).error,
        "Username must end with a letter or number.",
        bad
      );
    }
    for (const ok of ["staff1", "staff_1", "staff.x"]) {
      assert.equal(validateAccountUsername(ok).ok, true, ok);
    }
  });

  it("refuses reserved system words, exact matches only", () => {
    for (const bad of ["admin", "administrator", "root", "system", "owner", "support", "cartiq", "test"]) {
      assert.equal(
        validateAccountUsername(bad).error,
        "This username is reserved for the system.",
        bad
      );
    }
    assert.equal(validateAccountUsername("administrator1").ok, true);
    assert.equal(validateAccountUsername("joever_admin_a1").ok, true);
  });

  it("refuses offensive terms as substrings", () => {
    assert.equal(
      validateAccountUsername("joever_fuck").error,
      "This username contains inappropriate language."
    );
    assert.equal(
      validateAccountUsername("joever_gago1").error,
      "This username contains inappropriate language."
    );
    assert.equal(validateAccountUsername("joever_s1").ok, true);
  });

  it("treats mixed case identically (case-insensitive)", () => {
    assert.equal(validateAccountUsername("Admin123").value, "admin123");
    assert.equal(validateAccountUsername("joever_a").value, "joever_a");
  });

  it("allows underscores inside the name", () => {
    assert.equal(validateAccountUsername("staff_001").ok, true);
    assert.equal(validateAccountUsername("a_b_c_d").ok, true);
  });
});
