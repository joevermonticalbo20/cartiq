// The email subject must survive the trip to the mail client.
//
// A subject with an em dash ("Verify your email — CartIQ") written raw into
// the MIME header arrives as "â€"": the UTF-8 bytes are read as latin-1. ASCII
// is left alone; anything else is encoded per RFC 2047.
import test from "node:test";
import assert from "node:assert/strict";

import {
  encodeAddressHeader,
  encodeMimeHeader,
  verifyEmailContent,
} from "../src/services/gmail.js";

test("ASCII headers are left alone", () => {
  assert.equal(encodeMimeHeader("CartIQ password reset code"), "CartIQ password reset code");
  assert.equal(encodeMimeHeader(""), "");
});

test("a non-ASCII header is encoded as UTF-8 base64", () => {
  const encoded = encodeMimeHeader("Verify your email — CartIQ");
  assert.match(encoded, /^=\?UTF-8\?B\?.+\?=$/);
  const decoded = Buffer.from(
    encoded.replace(/^=\?UTF-8\?B\?/, "").replace(/\?=$/, ""),
    "base64",
  ).toString("utf8");
  assert.equal(decoded, "Verify your email — CartIQ");
});

test("an address keeps its address and only the name is encoded", () => {
  assert.equal(
    encodeAddressHeader("cartiq@example.com"),
    "cartiq@example.com",
  );
  // An ASCII display name needs no encoding at all.
  assert.equal(
    encodeAddressHeader("CartIQ Ops <cartiq@example.com>"),
    "CartIQ Ops <cartiq@example.com>",
  );
  // A non-ASCII one is encoded, and the address is left alone.
  const withName = encodeAddressHeader("CartIQ Öps <cartiq@example.com>");
  assert.match(withName, /^=\?UTF-8\?B\?.+\?= <cartiq@example\.com>$/);
});

test("the recovery-email subject is plain ASCII", () => {
  // Belt and braces: the subject is ASCII anyway, so even a client that ignores
  // RFC 2047 shows it correctly.
  const { subject } = verifyEmailContent("123456");
  assert.equal(subject, "Verify your email - CartIQ");
  assert.match(subject, /^[\x20-\x7E]+$/);
});
