import { describe, it, expect } from "vitest";

import {
  formatRfidBound,
  formatRfidConflict,
} from "../src/hooks/useRfidEvents.js";

describe("formatRfidBound", () => {
  it("names the staff member, the card and the cart", () => {
    const out = formatRfidBound({
      name: "Stall Staff 1",
      rfidUid: "04A2B3C4",
      locationCode: "CART-01",
    });
    expect(out).toContain("Stall Staff 1");
    expect(out).toContain("04A2B3C4");
    expect(out).toContain("CART-01");
  });

  it("falls back to username when the name is missing", () => {
    expect(formatRfidBound({ username: "staff07" })).toContain("staff07");
  });

  it("never renders an empty message on a partial payload", () => {
    expect(formatRfidBound({})).toBeTruthy();
    expect(formatRfidBound(undefined)).toBeTruthy();
  });

  it("calls out a replaced card, since the old one stops working", () => {
    const out = formatRfidBound({
      name: "Stall Staff 2",
      rfidUid: "NEWCAFE0",
      previousRfidUid: "OLDCARD1",
      replacedExisting: true,
    });
    expect(out).toContain("OLDCARD1");
    expect(out).toContain("replaced");
  });

  it("does not mention a swap when nothing was replaced", () => {
    const out = formatRfidBound({
      name: "Stall Staff 2",
      rfidUid: "NEWCAFE0",
      previousRfidUid: null,
      replacedExisting: false,
    });
    expect(out).not.toContain("replaced");
  });
});

describe("formatRfidConflict", () => {
  it("names the holder so the reader knows which card to grab instead", () => {
    const out = formatRfidConflict({
      rfidUid: "04A2B3C4",
      locationCode: "CART-01",
      holderName: "Stall Staff 9",
    });
    expect(out).toContain("Stall Staff 9");
    expect(out).toContain("04A2B3C4");
  });

  it("stays readable when the holder is unknown", () => {
    expect(formatRfidConflict({ rfidUid: "04A2B3C4" })).toBeTruthy();
  });
});