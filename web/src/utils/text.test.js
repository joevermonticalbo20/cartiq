import { describe, it, expect } from "vitest";
import {
  sanitizeTextInput,
  validateVendor,
  validateNote,
  countLetters,
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
    expect(validateVendor("7-Eleven #12").ok).toBe(true);
  });

  it("rejects empty and letter-less values", () => {
    expect(validateVendor("").ok).toBe(false);
    expect(validateVendor("   ").ok).toBe(false);
    expect(validateVendor("12").ok).toBe(false);
    expect(validateVendor("A1").ok).toBe(false);
  });

  it("truncates over-40 values to 40 (live cap, still valid)", () => {
    const r = validateVendor("a".repeat(41));
    expect(r.ok).toBe(true);
    expect(r.value).toBe("a".repeat(40));
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
