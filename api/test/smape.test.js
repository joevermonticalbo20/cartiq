import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { smape } from "../src/services/analytics_engine.js";

describe("smape (bounded backtest accuracy)", () => {
  it("is 0 for a perfect forecast", () => {
    assert.equal(smape([1, 2, 3], [1, 2, 3]), 0);
  });

  it("matches classic MAPE on stable days", () => {
    // a=1, p=1.1 -> 2*0.1/2.1*100 = 9.5
    assert.equal(smape([1], [1.1]), 9.5);
  });

  it("never exceeds 200 for non-negative inputs (bounded by construction)", () => {
    assert.equal(smape([0.03], [5]), 197.6);
    assert.ok(smape([0], [10]) <= 200);
    assert.ok(smape([100], [0]) <= 200);
  });

  it("skips zero/zero pairs and non-finite inputs", () => {
    assert.equal(smape([0, 1], [0, 1]), 0);
    assert.equal(smape([NaN, 1], [1, 1]), 0);
  });

  it("returns null when nothing qualifies", () => {
    assert.equal(smape([], []), null);
    assert.equal(smape([0, 0], [0, 0]), null);
  });

  it("stays within 0-200 on a noisy low-volume week", () => {
    const actual = [0.03, 0.09, 0.0, 0.12, 0.06, 0.03, 0.15];
    const predicted = [0.08, 0.07, 0.08, 0.08, 0.07, 0.09, 0.08];
    const v = smape(actual, predicted);
    assert.equal(typeof v, "number");
    assert.ok(v >= 0 && v <= 200, `got ${v}`);
  });
});
