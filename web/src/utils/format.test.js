import { describe, it, expect } from "vitest";
import {
  sanitizeMoneyInput,
  parseMoney,
  MAX_MONEY,
  sanitizeQtyInput,
  parseQty,
  MAX_QTY,
} from "./format.js";

describe("sanitizeMoneyInput", () => {
  it("passes normal amounts through", () => {
    expect(sanitizeMoneyInput("40")).toBe("40");
    expect(sanitizeMoneyInput("1234.56")).toBe("1234.56");
  });

  it("caps integer part at 7 digits", () => {
    expect(sanitizeMoneyInput("111111111111111111")).toBe("1111111");
  });

  it("caps decimals at 2 places", () => {
    expect(sanitizeMoneyInput("10.999")).toBe("10.99");
    expect(sanitizeMoneyInput("10.5")).toBe("10.5");
  });

  it("keeps a single dot and drops other characters", () => {
    expect(sanitizeMoneyInput("1e5")).toBe("15");
    expect(sanitizeMoneyInput("12.3.4")).toBe("12.34");
    expect(sanitizeMoneyInput("P1,200.50")).toBe("1200.50");
    expect(sanitizeMoneyInput("-50")).toBe("50");
  });

  it("preserves partial typing states", () => {
    expect(sanitizeMoneyInput("")).toBe("");
    expect(sanitizeMoneyInput("12.")).toBe("12.");
    expect(sanitizeMoneyInput(".5")).toBe(".5");
  });

  it("strips leading zeros but keeps zero itself", () => {
    expect(sanitizeMoneyInput("007")).toBe("7");
    expect(sanitizeMoneyInput("0")).toBe("0");
    expect(sanitizeMoneyInput("0.5")).toBe("0.5");
  });
});

describe("parseMoney", () => {
  it("parses valid amounts and rounds dust", () => {
    expect(parseMoney("40")).toBe(40);
    expect(parseMoney("10.5")).toBe(10.5);
  });

  it("rejects empty, negative, and over-cap values", () => {
    expect(parseMoney("")).toBeNull();
    expect(parseMoney("abc")).toBeNull();
    expect(parseMoney("-5")).toBeNull();
    expect(parseMoney("10000000")).toBeNull();
    expect(parseMoney(MAX_MONEY)).toBe(MAX_MONEY);
  });
});

describe("sanitizeQtyInput", () => {
  it("caps whole units at 5 digits and decimals at 2", () => {
    expect(sanitizeQtyInput("150")).toBe("150");
    expect(sanitizeQtyInput("123456")).toBe("12345");
    expect(sanitizeQtyInput("2.555")).toBe("2.55");
  });
});

describe("parseQty", () => {
  it("parses valid counts, rejects over-cap", () => {
    expect(parseQty("10")).toBe(10);
    expect(parseQty("")).toBeNull();
    expect(parseQty("100000")).toBeNull();
    expect(parseQty(MAX_QTY)).toBe(MAX_QTY);
  });
});
