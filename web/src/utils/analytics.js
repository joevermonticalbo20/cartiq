// Shared analytics helpers.
//
// The API returns one aggregate series per request. Charts that want a
// per-cart breakdown fetch each cart separately (already filtered by the same
// window) and merge the series onto the aggregate rows here, keyed by the cart
// code, so Recharts can stack one series per cart.
export function addCartBreakdowns(aggregate, cartResults) {
  if (!aggregate || cartResults.length === 0) return aggregate;
  const dailyByCode = new Map();
  const weekdaysByCode = new Map();
  for (const { code, data } of cartResults) {
    dailyByCode.set(code, new Map((data.daily_series ?? []).map((day) => [day.date, day.total_sales])));
    weekdaysByCode.set(code, new Map((data.by_weekday ?? []).map((day) => [day.dow, day.total_sales])));
  }
  return {
    ...aggregate,
    daily_series: (aggregate.daily_series ?? []).map((day) => ({
      ...day,
      ...Object.fromEntries([...dailyByCode].map(([code, series]) => [code, series.get(day.date) ?? 0])),
    })),
    by_weekday: (aggregate.by_weekday ?? []).map((day) => ({
      ...day,
      ...Object.fromEntries([...weekdaysByCode].map(([code, series]) => [code, series.get(day.dow) ?? 0])),
    })),
  };
}
