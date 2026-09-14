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

// --- Money input rules (single source for every amount field) ---
// Whole pesos: max 7 digits (9,999,999). Centavos: max 2 decimals.
export const MAX_MONEY_INT_DIGITS = 7;
export const MAX_MONEY_DECIMALS = 2;
export const MAX_MONEY = 9999999.99;

// Live-typing sanitizer for money fields: keeps digits + one dot, drops
// anything past 7 integer digits / 2 decimals. Extra keystrokes are ignored
// (never reformatted mid-typing, so the caret doesn't jump).
export function sanitizeMoneyInput(raw) {
  let s = String(raw ?? "").replace(/[^0-9.]/g, "");
  const dot = s.indexOf(".");
  if (dot !== -1) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, "");
  const hasDot = s.includes(".");
  let [int = "", dec = ""] = s.split(".");
  int = int.slice(0, MAX_MONEY_INT_DIGITS).replace(/^0+(?=\d)/, "");
  dec = dec.slice(0, MAX_MONEY_DECIMALS);
  return hasDot ? `${int}.${dec}` : int;
}

// Strict parse for submit: null when empty/invalid/negative/over the cap.
export function parseMoney(raw) {
  if (String(raw ?? "").trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > MAX_MONEY) return null;
  return Math.round(n * 100) / 100;
}
