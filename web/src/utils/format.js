// Shared chart/number formatting. Single source so every axis,
// tooltip, and table in the app formats money and dates the same way.

// Axis-safe money: P800 under a thousand, P1.2k / P12k above (never "P0k").
export function fmtMoneyAxis(v) {
  const n = Number(v) || 0;
  if (Math.abs(n) < 1000) return `P${Math.round(n)}`;
  return `P${(n / 1000).toFixed(Math.abs(n) >= 10000 ? 0 : 1)}k`;
}

// Full money for tooltips and tables: P12,450.
export function fmtMoney(v) {
  return `P${(Number(v) || 0).toLocaleString()}`;
}

// YYYY-MM-DD -> M/D so 30/90-day axes don't crowd.
export function fmtShortDate(d) {
  const s = String(d ?? "");
  const m = s.match(/^\d{4}-(\d{2})-(\d{2})/);
  if (m) return `${Number(m[1])}/${Number(m[2])}`;
  return s;
}
