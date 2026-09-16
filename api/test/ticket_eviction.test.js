import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { evictOverflow } from "../src/routes/events.js";

describe("evictOverflow", () => {
  it("evicts oldest-inserted first, never clears all", () => {
    const map = new Map([
      ["a", 1],
      ["b", 2],
      ["c", 3],
      ["d", 4],
      ["e", 5],
    ]);
    evictOverflow(map, 3);
    assert.deepEqual([...map.keys()], ["c", "d", "e"]);
  });

  it("leaves small maps untouched", () => {
    const map = new Map([["a", 1]]);
    evictOverflow(map, 1000);
    assert.deepEqual([...map.keys()], ["a"]);
  });
});
