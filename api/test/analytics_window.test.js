import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveAnalyticsWindow } from "../src/routes/analytics.js";

describe("resolveAnalyticsWindow", () => {
  it("falls back to a trailing days window", () => {
    const win = resolveAnalyticsWindow({ days: "14" });
    assert.equal(win.error, null);
    assert.equal(win.days, 14);
    assert.equal(win.end, null);
    assert.ok(win.start instanceof Date);
  });

  it("uses 28 days when nothing is asked for", () => {
    const win = resolveAnalyticsWindow({});
    assert.equal(win.days, 28);
  });

  it("accepts an explicit custom range", () => {
    const win = resolveAnalyticsWindow({
      startDate: "2026-11-01",
      endDate: "2026-11-05",
    });
    assert.equal(win.error, null);
    assert.equal(win.days, 5);
    assert.ok(win.start instanceof Date);
    assert.ok(win.end instanceof Date);
    // Manila midnight: 2026-11-01 00:00 PHT = 2026-10-31 16:00 UTC.
    assert.equal(win.start.toISOString(), "2026-10-31T16:00:00.000Z");
    assert.equal(win.end.toISOString(), "2026-11-05T16:00:00.000Z");
  });

  it("rejects a half-specified range", () => {
    assert.match(
      resolveAnalyticsWindow({ startDate: "2026-11-01" }).error,
      /both required/i
    );
    assert.match(
      resolveAnalyticsWindow({ endDate: "2026-11-05" }).error,
      /both required/i
    );
  });

  it("rejects a malformed date and a reversed range", () => {
    assert.match(
      resolveAnalyticsWindow({ startDate: "nope", endDate: "2026-11-05" }).error,
      /YYYY-MM-DD/i
    );
    assert.match(
      resolveAnalyticsWindow({ startDate: "2026-11-05", endDate: "2026-11-01" }).error,
      /must not be after/i
    );
  });
});
