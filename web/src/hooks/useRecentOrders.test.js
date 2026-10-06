import { describe, it, expect } from "vitest";
import { groupOrdersByCart, relativeTime } from "./useRecentOrders.js";

/**
 * The panel shows one row per cart, so the rollup arithmetic is what the
 * owner actually reads ("CART-01 - 3 orders - P240"). Getting a total wrong
 * here is worse than showing nothing, so it is asserted directly.
 */
describe("groupOrdersByCart", () => {
  const order = (over) => ({
    key: over.key ?? "k",
    cart: "CART-01",
    total: 100,
    items: 1,
    staffName: null,
    at: "2026-10-06T00:00:00.000Z",
    ...over,
  });

  it("returns an empty array for no input", () => {
    expect(groupOrdersByCart([])).toEqual([]);
    expect(groupOrdersByCart(null)).toEqual([]);
    expect(groupOrdersByCart(undefined)).toEqual([]);
  });

  it("keeps a single order as a one-row group", () => {
    const g = groupOrdersByCart([order({ total: 40 })]);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ cart: "CART-01", orders: 1, total: 40, items: 1 });
  });

  it("sums orders, money and items for the same cart", () => {
    const g = groupOrdersByCart([
      order({ key: "a", total: 40, items: 1 }),
      order({ key: "b", total: 80, items: 2 }),
      order({ key: "c", total: 120, items: 3 }),
    ]);
    expect(g).toHaveLength(1);
    expect(g[0].orders).toBe(3);
    expect(g[0].total).toBe(240);
    expect(g[0].items).toBe(6);
  });

  it("keeps separate carts separate", () => {
    const g = groupOrdersByCart([
      order({ key: "a", cart: "CART-01", total: 40 }),
      order({ key: "b", cart: "CART-02", total: 60 }),
      order({ key: "c", cart: "CART-01", total: 10 }),
    ]);
    expect(g).toHaveLength(2);
    const byCode = Object.fromEntries(g.map((x) => [x.cart, x]));
    expect(byCode["CART-01"]).toMatchObject({ orders: 2, total: 50 });
    expect(byCode["CART-02"]).toMatchObject({ orders: 1, total: 60 });
  });

  it("orders groups by their most recent order, newest first", () => {
    const g = groupOrdersByCart([
      order({ key: "old", cart: "CART-01", at: "2026-10-06T10:00:00.000Z" }),
      order({ key: "new", cart: "CART-02", at: "2026-10-06T11:00:00.000Z" }),
      order({ key: "mid", cart: "CART-03", at: "2026-10-06T10:30:00.000Z" }),
    ]);
    expect(g.map((x) => x.cart)).toEqual(["CART-02", "CART-03", "CART-01"]);
  });

  it("tracks the latest order's time and staff for the group", () => {
    const g = groupOrdersByCart([
      order({ key: "a", at: "2026-10-06T10:00:00.000Z", staffName: "Old Person" }),
      order({ key: "b", at: "2026-10-06T11:00:00.000Z", staffName: "New Person" }),
    ]);
    expect(g[0].latestAt).toBe("2026-10-06T11:00:00.000Z");
    expect(g[0].staffName).toBe("New Person");
  });

  it("survives a missing timestamp without throwing", () => {
    const g = groupOrdersByCart([order({ key: "a", at: undefined })]);
    expect(g).toHaveLength(1);
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-10-06T12:00:00.000Z");

  it("calls anything under 45 seconds 'just now'", () => {
    expect(relativeTime("2026-10-06T11:59:30.000Z", now)).toBe("just now");
  });

  it("reports minutes, then hours, then days", () => {
    expect(relativeTime("2026-10-06T11:58:00.000Z", now)).toBe("2 min ago");
    expect(relativeTime("2026-10-06T09:00:00.000Z", now)).toBe("3 hr ago");
    expect(relativeTime("2026-10-04T12:00:00.000Z", now)).toBe("2 d ago");
  });

  it("falls back to 'just now' on an unparseable value", () => {
    expect(relativeTime("not-a-date", now)).toBe("just now");
  });

  it("never reports a negative age (clock skew / future stamp)", () => {
    expect(relativeTime("2026-10-06T12:05:00.000Z", now)).toBe("just now");
  });
});