import { describe, it, expect } from "vitest";
import { alertLink, alertLinkLabel } from "./alertLinks.js";

describe("alertLink", () => {
  it("routes sales and void requests to the Sales page", () => {
    expect(alertLink({ type: "SALE" })).toBe("/sales");
    expect(alertLink({ type: "sale" })).toBe("/sales");
    expect(alertLink({ type: "VOID_REQUEST" })).toBe("/sales");
    expect(alertLinkLabel({ type: "VOID_REQUEST" })).toBe("Open sales");
  });

  it("routes stock alerts to the Inventory page", () => {
    for (const type of ["RESTOCK_REQUEST", "restock_request", "LOW_STOCK", "Critical", "INVENTORY"]) {
      expect(alertLink({ type })).toBe("/inventory");
    }
  });

  it("falls back to the notifications list for unknown types", () => {
    expect(alertLink({ type: "UNKNOWN_CARD" })).toBe("/notifications");
    expect(alertLink({ type: "something-new" })).toBe("/notifications");
    expect(alertLink({})).toBe("/notifications");
    expect(alertLink(null)).toBe("/notifications");
  });
});
