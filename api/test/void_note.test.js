// Void-note policy tests for the OWNER voiding an order. The web client
// enforces the same rules at keystroke; the server is the real gate.
import { test } from "node:test";
import assert from "node:assert/strict";

import { validateVoidNote, normalizeVoidNote, VOID_NOTE_MAX } from "../src/services/void_note.js";

test("normalize collapses whitespace and trims", () => {
  assert.equal(normalizeVoidNote("  hello   world\n again "), "hello world again");
});

test("empty note is rejected", () => {
  assert.equal(validateVoidNote("").ok, false);
  assert.equal(validateVoidNote("   ").ok, false);
});

test("note shorter than 20 characters is rejected", () => {
  const res = validateVoidNote("too short note");
  assert.equal(res.ok, false);
  assert.match(res.error, /at least 20/);
});

test("note longer than 100 characters is rejected", () => {
  const res = validateVoidNote("a".repeat(VOID_NOTE_MAX + 1));
  assert.equal(res.ok, false);
  assert.match(res.error, /must not exceed 100/);
});

test("disallowed characters are rejected", () => {
  const res = validateVoidNote("Customer allergy, voids! (email) <b>x</b>");
  assert.equal(res.ok, false);
  assert.match(res.error, /letters, digits/);
});

test("three identical characters in a row are rejected, case-insensitive", () => {
  assert.equal(validateVoidNote("Order has 111 units wrong, void it now").ok, false);
  assert.equal(validateVoidNote("typed AAA by mistake, voiding it now").ok, false);
  assert.equal(validateVoidNote("mistook QQQ for 2, voiding order now").ok, false);
});

test("letters, digits, spaces and , . - _ are accepted", () => {
  const res = validateVoidNote("Wrong item, void order - customer says no. Refund ok_1");
  assert.equal(res.ok, true);
  assert.equal(res.value.length >= 20, true);
});

test("double spaces are normalized away before validation", () => {
  const res = validateVoidNote("wrong  item,  void   order because mistyped");
  assert.equal(res.ok, true);
  assert.equal(res.value, "wrong item, void order because mistyped");
});
