import { describe, it, expect } from "vitest";

import { sanitizeVoidNoteTyping, validateVoidNote, VOID_NOTE_MAX, VOID_NOTE_MIN } from "./voidNote.js";

describe("sanitizeVoidNoteTyping", () => {
  it("strips disallowed characters, keeps letters/digits/space/, . - _", () => {
    expect(sanitizeVoidNoteTyping("Hello, World - test_1!")).toBe("Hello, World - test_1");
    expect(sanitizeVoidNoteTyping("no emoji 🎉 here")).toBe("no emoji here");
  });

  it("collapses runs of spaces into a single space and strips leading spaces", () => {
    expect(sanitizeVoidNoteTyping("hello    world")).toBe("hello world");
    expect(sanitizeVoidNoteTyping("   leading")).toBe("leading");
  });

  it("refuses the third consecutive identical character, case-insensitive — including mixed case", () => {
    expect(sanitizeVoidNoteTyping("aaaaa")).toBe("aa");
    expect(sanitizeVoidNoteTyping("AAAA")).toBe("AA");
    expect(sanitizeVoidNoteTyping("AAa")).toBe("AA");
    expect(sanitizeVoidNoteTyping("aAAb")).toBe("aAb");
    expect(sanitizeVoidNoteTyping("QQQ")).toBe("QQ");
    expect(sanitizeVoidNoteTyping("111")).toBe("11");
  });

  it("caps at VOID_NOTE_MAX", () => {
    expect(sanitizeVoidNoteTyping("a".repeat(200)).length).toBeLessThanOrEqual(VOID_NOTE_MAX);
  });
});

describe("validateVoidNote", () => {
  it("rejects an empty note", () => {
    expect(validateVoidNote("").ok).toBe(false);
    expect(validateVoidNote("   ").ok).toBe(false);
  });

  it("rejects a single-letter note, allows a normal two-letter minimum", () => {
    expect(validateVoidNote("a").error).toBe("A single letter is not valid - the minimum is 2.");
    expect(validateVoidNote("ok").ok).toBe(true);
  });

  it("rejects a note longer than 100 characters", () => {
    expect(validateVoidNote("a".repeat(VOID_NOTE_MAX + 1)).error).toBe("Note must not exceed 100 characters.");
  });

  it("rejects disallowed characters", () => {
    expect(validateVoidNote("VOID because customer allergy!").error).toMatch(/letters, digits/);
  });

  it("rejects three identical characters in a row", () => {
    expect(validateVoidNote("aaabbb would never happen here").error).toMatch(/three identical/i);
  });

  it("accepts a normal void note", () => {
    const res = validateVoidNote("Customer allergy - ordered pork-free, remake required");
    expect(res.ok).toBe(true);
    expect(res.value.length).toBeGreaterThanOrEqual(VOID_NOTE_MIN);
  });
});
