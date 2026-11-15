import { describe, it, expect } from "vitest";
import {
  sanitizeTextInput,
  validateVendor,
  validateNote,
  validateItemName,
  countLetters,
  validateEmail,
  validateRfidUid,
  validateDeviceId,
  FULL_NAME_MAX,
  validateFullName,
  validateAccountUsername,
  validateTextLine,
} from "./text.js";

describe("sanitizeTextInput", () => {
  it("collapses multiple spaces and strips a leading space", () => {
    expect(sanitizeTextInput("SM   Supermarket")).toBe("SM Supermarket");
    expect(sanitizeTextInput("  SM")).toBe("SM");
    expect(sanitizeTextInput("SM ")).toBe("SM ");
  });

  it("caps at 40 chars", () => {
    expect(sanitizeTextInput("a".repeat(50))).toBe("a".repeat(40));
  });

  it("keeps special characters and numbers", () => {
    expect(sanitizeTextInput("7-Eleven #12!")).toBe("7-Eleven #12!");
  });
});

describe("countLetters", () => {
  it("counts Unicode letters only", () => {
    expect(countLetters("SM")).toBe(2);
    expect(countLetters("7-Eleven")).toBe(6);
    expect(countLetters("123!@#")).toBe(0);
    expect(countLetters("Peña")).toBe(4);
  });
});

describe("validateVendor", () => {
  it("accepts normal vendors", () => {
    expect(validateVendor("SM Supermarket").ok).toBe(true);
    expect(validateVendor("Juan Store").ok).toBe(true);
    expect(validateVendor("ABC Supplier").ok).toBe(true);
  });

  it("rejects values shorter than 3 characters", () => {
    expect(validateVendor("AB").ok).toBe(false);
    expect(validateVendor("AB").error).toBe("Vendor must be at least 3 characters.");
    expect(validateVendor("AL").ok).toBe(false);
    expect(validateVendor("ABC").ok).toBe(true);
  });

  it("rejects values longer than 30 characters", () => {
    const over = "ABC" + "Def".repeat(9); // 30 chars
    expect(validateVendor(over).ok).toBe(true);
    expect(validateVendor(over + "G").ok).toBe(false);
    expect(validateVendor(over + "G").error).toBe("Vendor must not exceed 30 characters.");
  });

  it("rejects empty and whitespace-only values", () => {
    expect(validateVendor("").ok).toBe(false);
    expect(validateVendor("   ").ok).toBe(false);
    expect(validateVendor("").error).toBe("Vendor is required.");
  });

  it("collapses runs of spaces to a single space", () => {
    expect(validateVendor("ABC  Supplier")).toEqual({ ok: true, value: "ABC Supplier" });
    expect(validateVendor("  Juan   Store  ")).toEqual({ ok: true, value: "Juan Store" });
  });

  it("accepts single spaces and hyphenated/apostrophe names", () => {
    expect(validateVendor("Maria's Store").ok).toBe(true);
    expect(validateVendor("Supplies-R-Us").ok).toBe(true);
  });
});

describe("validateTextLine", () => {
  it("enforces min length with its own message", () => {
    expect(validateTextLine("AB", { label: "Category", min: 3, max: 30 })).toEqual({
      ok: false,
      value: "AB",
      error: "Category must be at least 3 characters.",
    });
  });

  it("enforces max length with its own message", () => {
    expect(validateTextLine("x".repeat(31), { label: "Flavor name", min: 3, max: 20 })).toEqual({
      ok: false,
      value: "x".repeat(31),
      error: "Flavor name must not exceed 20 characters.",
    });
  });

  it("rejects whitespace-only input", () => {
    expect(validateTextLine("     ", { label: "Recipe item", min: 3, max: 30 })).toEqual({
      ok: false,
      value: "",
      error: "Recipe item is required.",
    });
  });

  it("trims and collapses single spaces", () => {
    expect(validateTextLine("  Cheese   Fries  ", { label: "Category", min: 3, max: 30 })).toEqual({
      ok: true,
      value: "Cheese Fries",
    });
  });
});

describe("validateNote", () => {
  it("allows empty (optional)", () => {
    expect(validateNote("")).toEqual({ ok: true, value: "" });
  });

  it("enforces 2 letters when provided; over-40 is truncated to 40", () => {
    expect(validateNote("ok").ok).toBe(true);
    expect(validateNote("x").ok).toBe(false);
    const long = validateNote("b".repeat(41));
    expect(long.ok).toBe(true);
    expect(long.value).toBe("b".repeat(40));
  });
});

describe("validateEmail", () => {
  it("allows empty (clears the field)", () => {
    expect(validateEmail("")).toEqual({ ok: true, value: "" });
  });

  it("trims whitespace and stores the address lowercased", () => {
    expect(validateEmail("  owner@example.com  ")).toEqual({
      ok: true,
      value: "owner@example.com",
    });
  });

  it("refuses uppercase anywhere, e.g. Gmail.com", () => {
    expect(validateEmail("Owner@Gmail.com").ok).toBe(false);
    expect(validateEmail("Owner@Gmail.com").error).toBe("Please enter a valid email address.");
    expect(validateEmail("owner@Gmail.com").ok).toBe(false);
    expect(validateEmail("owner@example.com").ok).toBe(true);
  });

  it("rejects a shape that cannot be a mailbox", () => {
    expect(validateEmail("abc").ok).toBe(false);
    expect(validateEmail("a@b").ok).toBe(false);
    expect(validateEmail("a b@example.com").ok).toBe(false);
    expect(validateEmail("@example.com").ok).toBe(false);
    expect(validateEmail("owner@example..com").ok).toBe(false);
    expect(validateEmail("owner@..example.com").ok).toBe(false);
    expect(validateEmail("owner@example.c").ok).toBe(false);
    expect(validateEmail("owner@@example.com").ok).toBe(false);
    expect(validateEmail("owner.example.com").ok).toBe(false);
  });

  it("rejects an over-long address", () => {
    expect(validateEmail(`${"a".repeat(120)}@example.com`).ok).toBe(false);
  });
});

describe("validateRfidUid", () => {
  it("allows empty (clears the field)", () => {
    expect(validateRfidUid("")).toEqual({ ok: true, value: "" });
  });

  it("normalises separators and case", () => {
    expect(validateRfidUid("04 a2-b3:c4").value).toBe("04A2B3C4");
  });

  it("rejects non-hex and out-of-range values", () => {
    expect(validateRfidUid("ZZZZ").ok).toBe(false);
    expect(validateRfidUid("04A2").ok).toBe(false); // 2 bytes is too short
    expect(validateRfidUid("A".repeat(21)).ok).toBe(false);
  });
});

describe("validateDeviceId", () => {
  it("requires 3-40 safe characters", () => {
    expect(validateDeviceId("esp32-cart-01").ok).toBe(true);
    expect(validateDeviceId("ab").ok).toBe(false);
    expect(validateDeviceId("has space").ok).toBe(false);
    expect(validateDeviceId("x".repeat(41)).ok).toBe(false);
    expect(validateDeviceId("").ok).toBe(false);
  });
});

describe("validateItemName", () => {
  it("accepts normal names with numbers and symbols", () => {
    expect(validateItemName("Cheese Powder").ok).toBe(true);
    expect(validateItemName("LPG Tank 11kg").ok).toBe(true);
  });

  it("rejects empty and letter-less values", () => {
    expect(validateItemName("").ok).toBe(false);
    expect(validateItemName("12").ok).toBe(false);
    expect(validateItemName("A1").ok).toBe(false);
  });

  it("truncates over-30 values to 30 (live cap, still valid)", () => {
    const long = validateItemName("c".repeat(31));
    expect(long.ok).toBe(true);
    expect(long.value).toBe("c".repeat(30));
  });
});

describe("validateFullName (staff/admin accounts)", () => {
  it("accepts the documented valid names", () => {
    for (const ok of [
      "Juan Dela Cruz",
      "Maria Clara Santos",
      "Anne-Marie Lopez",
      "O'Connor Reyes",
      "José Peña",
      "Ñoño Santos",
    ]) {
      expect(validateFullName(ok).ok).toBe(true);
    }
  });

  it("refuses empty input with the exact message", () => {
    expect(validateFullName("")).toEqual({
      ok: false,
      value: "",
      error: "Full name is required.",
    });
    expect(validateFullName("   ").error).toBe("Full name is required.");
  });

  it("enforces 2..30 characters", () => {
    expect(validateFullName("J").error).toBe("Full name must be at least 2 characters.");
    expect(validateFullName("Jo").ok).toBe(true);
    expect(validateFullName("x".repeat(FULL_NAME_MAX)).ok).toBe(false); // same-letter run
    const varied = "abcdefg ABCDEFG ".repeat(2).slice(0, FULL_NAME_MAX);
    expect(varied.length).toBe(FULL_NAME_MAX);
    expect(validateFullName(varied).ok).toBe(true);
    expect(validateFullName("x".repeat(FULL_NAME_MAX + 1)).error).toBe(
      "Full name must not exceed 30 characters."
    );
  });

  it("requires at least two letters with the punctuation allowed", () => {
    expect(validateFullName("-'-'-'").error).toBe("Please enter a valid full name.");
    expect(validateFullName("A-").error).toBe("Please enter a valid full name.");
    expect(validateFullName("AB").ok).toBe(true);
  });

  it("refuses a run of 3+ identical letters anywhere in the name", () => {
    for (const bad of ["AAa", "aaaa", "AAaa", "Mariaaa Clara", "BBBB Boots"]) {
      expect(validateFullName(bad).ok, bad).toBe(false);
      expect(validateFullName(bad).error).toBe("Please enter a valid full name.");
    }
    for (const ok of ["Aaron", "Yyan", "Juan Dela Cruz"]) {
      expect(validateFullName(ok).ok, ok).toBe(true);
    }
  });

  it("refuses numbers and special characters, including HTML", () => {
    for (const bad of ["Juan123", "123456", "@@@@@", "<script>alert(1)</script>", "Juan@Dela"]) {
      expect(validateFullName(bad).ok).toBe(false);
      expect(validateFullName(bad).error).toBe(
        "Full name cannot contain numbers or special characters."
      );
    }
  });

  it("requires at least one letter even when the punctuation is allowed", () => {
    expect(validateFullName("-'-'-'").error).toBe("Please enter a valid full name.");
  });

  it("trims leading and trailing spaces", () => {
    expect(validateFullName("   Juan Dela Cruz   ")).toEqual({
      ok: true,
      value: "Juan Dela Cruz",
    });
  });
});

describe("validateAccountUsername (staff/admin accounts)", () => {
  it("accepts the documented valid usernames", () => {
    for (const ok of ["juandelacruz", "juan123", "staff_001", "admin2026"]) {
      expect(validateAccountUsername(ok).ok).toBe(true);
    }
  });

  it("converts to lowercase before storing", () => {
    expect(validateAccountUsername("Staff_01")).toEqual({ ok: true, value: "staff_01" });
    expect(validateAccountUsername("  JUANDELACRUZ  ")).toEqual({
      ok: true,
      value: "juandelacruz",
    });
  });

  it("refuses empty input with the exact message", () => {
    expect(validateAccountUsername("")).toEqual({
      ok: false,
      value: "",
      error: "Username is required.",
    });
  });

  it("enforces 4..20 characters", () => {
    expect(validateAccountUsername("abc").error).toBe(
      "Username must be between 4 and 20 characters."
    );
    expect(validateAccountUsername("a".repeat(21)).error).toBe(
      "Username must be between 4 and 20 characters."
    );
    expect(validateAccountUsername("abcd").ok).toBe(true);
    expect(validateAccountUsername("a".repeat(20)).ok).toBe(true);
  });

  it("refuses consecutive periods or underscores (same or mixed)", () => {
    for (const bad of ["ab__cd", "ab..cd", "ab_.cd", "ab._cd", "staff__01"]) {
      expect(validateAccountUsername(bad).error, bad).toBe(
        "Username cannot contain consecutive underscores or periods."
      );
    }
  });

  it("must end with a letter or number", () => {
    expect(validateAccountUsername("staff_").error).toBe(
      "Username must end with a letter or number."
    );
    expect(validateAccountUsername("staff.").error).toBe(
      "Username must end with a letter or number."
    );
    expect(validateAccountUsername("staff_1").ok).toBe(true);
  });

  it("refuses periods and reserved system words", () => {
    expect(validateAccountUsername("jo..ver").ok).toBe(false);
    expect(validateAccountUsername("admin").error).toBe(
      "This username is reserved for the system."
    );
    expect(validateAccountUsername("owner").error).toBe(
      "This username is reserved for the system."
    );
  });

  it("refuses offensive terms as substrings", () => {
    expect(validateAccountUsername("joever_fuck").error).toBe(
      "This username contains inappropriate language."
    );
    expect(validateAccountUsername("staff_puta").error).toBe(
      "This username contains inappropriate language."
    );
  });

  it("must start with a letter", () => {
    expect(validateAccountUsername("12345678").error).toBe(
      "Username must start with a letter."
    );
    expect(validateAccountUsername("_staff01").error).toBe(
      "Username must start with a letter."
    );
  });

  it("refuses spaces and special characters", () => {
    for (const bad of ["joever@123", "staff 001", "@@@@@@@", "staff!01"]) {
      expect(validateAccountUsername(bad).ok).toBe(false);
      expect(validateAccountUsername(bad).error).toBe(
        "Username cannot contain spaces or special characters."
      );
    }
  });
});
