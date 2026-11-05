import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  handlers: new Map(),
  toast: vi.fn(),
  navigate: vi.fn(),
  patch: vi.fn(() => Promise.resolve()),
}));

vi.mock("./useLiveStream.js", () => ({
  useLiveEvent: (event, handler) => mocks.handlers.set(event, handler),
}));
vi.mock("../components/Toast.jsx", () => ({ toast: mocks.toast }));
vi.mock("react-router-dom", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../api.js", () => ({ default: { patch: mocks.patch } }));

import { formatOrderNotice, useOrderNotifications } from "./useOrderNotifications.js";

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

/**
 * A sale arrives twice on the stream: once as `order:new`, once as a SALE
 * `alert:new`. The screenshot that reported this showed both toasts stacked,
 * so the rule is asserted here: one sale = one toast, while alerts that have
 * no order event still get theirs.
 */
describe("live notification dedupe", () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.toast.mockClear();
    mocks.navigate.mockClear();
    mocks.patch.mockClear();
  });

  it("does not toast a SALE alert that order:new already announced", () => {
    renderHook(() => useOrderNotifications());
    mocks.handlers.get("alert:new")({
      id: 17,
      type: "SALE",
      message: "New sale: ₱20.00 · 1 item(s) at CART-01 · Stall Staff 1",
    });
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("still toasts alerts that have no order event", () => {
    renderHook(() => useOrderNotifications());
    mocks.handlers.get("alert:new")({
      id: 4,
      type: "LOW_STOCK",
      message: "BBQ Powder @ CART-01 dropped below threshold",
    });
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(mocks.toast.mock.calls[0][0]).toContain("Alert: BBQ Powder");
  });

  it("shows exactly one toast for a new order", () => {
    renderHook(() => useOrderNotifications());
    mocks.handlers.get("order:new")({
      total: 20,
      locationCode: "CART-01",
      itemCount: 1,
      staffName: "Stall Staff 1",
    });
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(mocks.toast.mock.calls[0][0]).toBe(
      "New order on CART-01 - ₱20.00 (1 item) - Stall Staff 1"
    );
  });
});