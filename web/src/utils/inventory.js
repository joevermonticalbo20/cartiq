// Inventory rules shared between the Add Item modal, the threshold edit and
// the stock-adjust flow. The backend enforces the same rules - see
// api/src/services/inventory_validation.js (keep both in sync).
//
//   Units (exactly the dropdown the UI offers):
//     pcs, kg, g, packs, liters
//
//   Unit-based numbers:
//     pcs / packs  - whole numbers,   0..99,999
//     kg / g/ liters - decimals (2 places), 0..99,999.99
//     negative values refused; NaN/Infinity/scientific notation refused
//
//   Status:
//     OK: stock > threshold
//     Low Stock: stock > 0 && stock <= threshold
//     Out of Stock: stock == 0 (takes priority over Low Stock)

export const UNIT_OPTIONS = [
  { value: "pcs", label: "Pieces (pcs)" },
  { value: "kg", label: "Kilograms (kg)" },
  { value: "g", label: "Grams (g)" },
  { value: "packs", label: "Packs" },
  { value: "liters", label: "Liters" },
];

// The predefined categories in the Add Item dropdown. The backend accepts
// exactly these values - the rest are manual bypasses.
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

export function sanitizeInventoryNameTyping(raw) {
  let s = String(raw ?? "").replace(/[^\p{L}\p{N}\p{M} %(),.-]/gu, "");
  s = s.replace(/\s+/g, " ");
  if (s.length > 100) s = s.slice(0, 100);
  return s;
}

// Reject anything that is not a plain decimal - letters, "e"/"E", "-",
// multiple dots, NaN, Infinity, scientific notation.
const DECIMAL_RE = /^\d+(\.\d{0,2})?$/;

/** Live-typing sanitizer for qty fields, unit aware. Returns "" or a clean value. */
export function sanitizeQtyForUnit(raw, unit) {
  let s = String(raw ?? "").replace(/[^0-9.]/g, "");
  const dot = s.indexOf(".");
  if (dot !== -1) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, "");
  if (isWholeUnit(unit)) {
    const intPart = s.split(".")[0] ?? "";
    return intPart.slice(0, 5);
  }
  const hasDot = s.includes(".");
  let [int = "", dec = ""] = s.split(".");
  int = int.slice(0, 5);
  dec = dec.slice(0, 2);
  return (hasDot ? `${int}.${dec}` : int).replace(/^0+(?=\d)/, "");
}

/**
 * Strict parse for submit. Returns { ok, value, error }.
 * value is a number (0 allowed, whole for pcs/packs).
 */
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
  if (!/^[\p{L}\p{N}\p{M} %(),.-]+$/u.test(value)) {
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

export const STOCK_STATUS_LABEL = { ok: "OK", low: "LOW STOCK", out: "OUT OF STOCK" };
