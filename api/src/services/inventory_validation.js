// Inventory rules (Add Item modal), mirroring web/src/utils/inventory.js.
// Imported by routes/inventory.js and re- exported there for the Edge mirror
// (supabase/functions/api/index.ts keeps an inline copy - keep both in sync).

export const UNIT_OPTIONS = ["pcs", "kg", "g", "packs", "liters"];

// The predefined categories in the Add Item dropdown - accepted exactly as
// written, anything else is a bypass.
export const INVENTORY_CATEGORIES = ["Ingredients", "Packaging", "Cleaning", "Others"];

const UNIT_NORMALISE = { pcs: "pcs", kg: "kg", g: "g", packs: "packs", liters: "liters" };

export function isWholeUnit(unit) {
  const u = String(unit ?? "").trim().toLowerCase();
  return u === "pcs" || u === "packs";
}

export function isSupportedUnit(unit) {
  const u = String(unit ?? "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(UNIT_NORMALISE, u);
}

export function normalizeUnit(unit) {
  const u = String(unit ?? "").trim().toLowerCase();
  return UNIT_NORMALISE[u] ?? null;
}

// Reject anything that is not a plain decimal - letters, "e"/"E", "-",
// multiple dots, NaN, Infinity, scientific notation.
const DECIMAL_RE = /^\d+(\.\d{0,2})?$/;

/** Strict parse for submit. Returns { ok, value, error }. */
export function parseQtyForUnit(raw, unit) {
  const s = String(raw ?? "").trim();
  if (!s) return { ok: false, value: null, error: "required" };
  if (!DECIMAL_RE.test(s)) {
    return { ok: false, value: null, error: "not a number" };
  }
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) {
    return { ok: false, value: null, error: "not a number" };
  }
  if (isWholeUnit(unit)) {
    if (!Number.isInteger(n)) {
      return { ok: false, value: null, error: "whole number" };
    }
    if (n > 99999) {
      return { ok: false, value: null, error: "too big" };
    }
    return { ok: true, value: n };
  }
  if (n > 99999.99) {
    return { ok: false, value: null, error: "too big" };
  }
  return { ok: true, value: Math.round(n * 100) / 100 };
}

/** Inventory item name rules (Add Item modal). Returns { ok, value, error }. */
export function validateInventoryItemName(raw) {
  const value = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!value) return { ok: false, value, error: "Item name is required." };
  if (value.length < 2) {
    return { ok: false, value, error: "Item name must contain at least 2 characters." };
  }
  if (value.length > 100) {
    return { ok: false, value, error: "Item name must not exceed 100 characters." };
  }
  // Letters (any script), marks, numbers, spaces, hyphens, parentheses,
  // periods, commas and percentage only. No HTML, JS or other punctuation.
  if (!/^[\p{L}\p{N}\p{M} %(),.\-]+$/u.test(value)) {
    return { ok: false, value, error: "Please enter a valid item name." };
  }
  return { ok: true, value };
}

/** Inventory status: OK | Low Stock | Out of Stock. Out takes priority. */
export function stockStatusOf(stock, threshold) {
  const s = Number(stock) || 0;
  const t = Number(threshold) || 0;
  if (s <= 0) return "out";
  if (s > t) return "ok";
  return "low";
}

/** Case-insensitive duplicate check against same-cart siblings. */
export function siblingNameClash(siblings, candidate) {
  const target = String(candidate ?? "").trim().toLowerCase();
  if (!target) return null;
  return siblings.find((s) => String(s.name ?? "").trim().toLowerCase() === target) ?? null;
}
