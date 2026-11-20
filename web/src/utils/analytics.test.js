import { describe, it, expect } from "vitest";
import { addCartBreakdowns } from "./analytics.js";

describe("addCartBreakdowns", () => {
  it("adds one key per cart on daily and weekday rows", () => {
    const aggregate = {
      total_sales: 300,
      daily_series: [
        { date: "2026-11-19", total_sales: 150 },
        { date: "2026-11-20", total_sales: 150 },
      ],
      by_weekday: [
        { dow: 4, label: "Thu", total_sales: 150 },
        { dow: 5, label: "Fri", total_sales: 150 },
      ],
    };
    const carts = [
      { code: "CART-01", data: { daily_series: [{ date: "2026-11-19", total_sales: 100 }], by_weekday: [{ dow: 4, total_sales: 100 }] } },
      { code: "CART-02", data: { daily_series: [{ date: "2026-11-20", total_sales: 50 }], by_weekday: [{ dow: 5, total_sales: 50 }] } },
    ];

    const merged = addCartBreakdowns(aggregate, carts);

    expect(merged.total_sales).toBe(300);
    expect(merged.daily_series[0]).toMatchObject({ "CART-01": 100, "CART-02": 0 });
    expect(merged.daily_series[1]).toMatchObject({ "CART-01": 0, "CART-02": 50 });
    expect(merged.by_weekday[0]).toMatchObject({ dow: 4, "CART-01": 100, "CART-02": 0 });
    expect(merged.by_weekday[1]).toMatchObject({ dow: 5, "CART-01": 0, "CART-02": 50 });
  });

  it("returns the aggregate unchanged when no cart result succeeded", () => {
    const aggregate = { total_sales: 10, by_weekday: [] };
    expect(addCartBreakdowns(aggregate, [])).toBe(aggregate);
    expect(addCartBreakdowns(null, [{ code: "CART-01", data: {} }])).toBeNull();
  });
});
