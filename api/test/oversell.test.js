import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  oversellShortage,
  fmtStock,
} from "../src/services/inventory_rules.js";

describe("oversellShortage", () => {
  it("10 - 3 leaves stock 7 with no shortage", () => {
    assert.equal(oversellShortage(10, 1, 3), 0);
  });

  it("exact deduction 3 - 3 leaves no shortage", () => {
    assert.equal(oversellShortage(3, 1, 3), 0);
  });

  it("oversell 3 - 5 reports shortage 2", () => {
    assert.equal(oversellShortage(3, 1, 5), 2);
  });

  it("zero-stock sale 0 - 5 reports shortage 5", () => {
    assert.equal(oversellShortage(0, 1, 5), 5);
  });

  it("fractional recipe math stays exact (0.05 - 2x0.03)", () => {
    assert.equal(oversellShortage(0.05, 0.03, 2), 0.01);
  });

  it("sufficient fractional stock reports no shortage", () => {
    assert.equal(oversellShortage(1, 0.03, 2), 0);
  });
});

describe("fmtStock", () => {
  it("trims float dust", () => {
    assert.equal(fmtStock(0.1 + 0.2), 0.3);
    assert.equal(fmtStock(12.45), 12.45);
  });
});
