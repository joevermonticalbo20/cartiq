import { describe, it, expect } from "vitest";
import { formatOrderNotice } from "./useOrderNotifications.js";

/**
 * The operator reads this text when a sale happens on the POS, so the wording
 * is asserted rather than eyeballed: it must name the CART (the whole point of
 * the notification), show a peso amount with centavos, and survive a partial
 * payload instead of rendering "undefined".
 */
describe("formatOrderNotice", () => {
  it("names the cart, the peso total and the item count", () => {
    const notice = formatOrderNotice({
      id: 12,
      total: 118.5,
      locationCode: "CART-01",
      itemCount: 2,
      staffName: "Stall Staff 1",
    });

    expect(notice.title).toBe("New order on CART-01");
    expect(notice.body).toContain("₱118.50");
    expect(notice.body).toContain("2 items");
    expect(notice.body).toContain("Stall Staff 1");
    expect(notice.message).toContain("CART-01");
    expect(notice.message).toContain("₱118.50");
  });

  it("uses the singular item word for a single-item order", () => {
    const notice = formatOrderNotice({ total: 40, locationCode: "CART-02", itemCount: 1 });
    expect(notice.body).toContain("1 item");
    expect(notice.body).not.toContain("1 items");
  });

  it("keeps centavos instead of rounding them away", () => {
    // The POS shows change with 2 decimals; the owner must see the same figure.
    const notice = formatOrderNotice({ total: 60.25, locationCode: "CART-03", itemCount: 1 });
    expect(notice.body).toContain("₱60.25");
  });

  it("survives a missing payload without printing undefined", () => {
    const notice = formatOrderNotice({});
    expect(notice.message).not.toMatch(/undefined|NaN/);
    expect(notice.title).toContain("?");
    expect(notice.message).toContain("₱0.00");
  });

  it("survives a null payload entirely", () => {
    const notice = formatOrderNotice(null);
    expect(notice.message).not.toMatch(/undefined|NaN/);
  });
});