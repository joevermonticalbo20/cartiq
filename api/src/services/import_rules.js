// Bulk-import row validation for POST /import/products. Bounds mirror the
// single-product endpoints (routes/products.js: name 2 letters/120 max,
// category sliced to 60, flavor 1-60) plus DoS caps: without them one cell
// with ~10k flavor names turns into ~10k sequential Firestore writes.
// Pure functions so the rules are unit-testable without a database.

export const IMPORT_MAX_ROWS = 2000;
export const IMPORT_MAX_NAME_LEN = 120;
export const IMPORT_MAX_CATEGORY_LEN = 60;
export const IMPORT_MAX_PRICE = 10_000_000;
export const IMPORT_MAX_FLAVORS_PER_ROW = 20;
export const IMPORT_MAX_FLAVOR_LEN = 60;

/** Split a flavors cell ("Cheese;BBQ") the same way the import route does. */
export function splitFlavorCell(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return [];
  return text
    .split(/[;,]/)
    .map((f) => f.trim())
    .filter(Boolean);
}

/**
 * Split an option-prices cell ("Large=30;XL 40=40") into a map.
 *
 * The fries menu stores the SIZES as the product's options, and each size has
 * its own price - without this column an import would give every size the
 * same price.
 */
export function splitOptionPricesCell(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return {};
  const out = {};
  for (const part of text.split(/[;,]/)) {
    const [rawName, rawPrice] = part.split("=");
    const name = String(rawName ?? "").trim();
    const price = Number(String(rawPrice ?? "").trim());
    if (!name || !Number.isFinite(price) || price <= 0) continue;
    out[name] = price;
  }
  return out;
}

/**
 * Parse a cost cell ("" = unknown cost).
 *
 * @returns {{ cost: number|null, reason: string|null }} the parsed cost and,
 *   when the cell is not a usable number, the reason for the row's errors[].
 */
export function parseCostCell(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { cost: null, reason: null };
  const cost = Number(text);
  if (!Number.isFinite(cost) || cost <= 0) {
    return { cost: null, reason: `invalid cost "${text}"` };
  }
  return { cost, reason: null };
}

/**
 * Validate one parsed import row.
 *
 * @param {object} row
 * @param {string} row.name
 * @param {string} row.category
 * @param {number} row.basePrice
 * @param {string[]} row.flavorNames
 * @param {number|null} [row.cost] optional cost per unit (must be <= basePrice)
 * @param {Record<string, number>} [row.optionPrices] per-option prices
 *   (each must be <= basePrice and name an option of the row)
 * @returns {string|null} null when valid, otherwise the human-readable reason
 *   for the row's errors[] entry.
 */
export function validateProductRow({
  name,
  category,
  basePrice,
  flavorNames,
  cost = null,
  optionPrices = {},
}) {
  if (!name) return "missing name";
  if (name.length > IMPORT_MAX_NAME_LEN) {
    return `name exceeds ${IMPORT_MAX_NAME_LEN} characters`;
  }
  if (!Number.isFinite(basePrice) || basePrice <= 0) {
    return `invalid basePrice "${basePrice}"`;
  }
  if (basePrice > IMPORT_MAX_PRICE) {
    return `basePrice exceeds ${IMPORT_MAX_PRICE.toLocaleString("en-US")}`;
  }
  if ((category ?? "").length > IMPORT_MAX_CATEGORY_LEN) {
    return `category exceeds ${IMPORT_MAX_CATEGORY_LEN} characters`;
  }
  const flavors = flavorNames ?? [];
  if (flavors.length > IMPORT_MAX_FLAVORS_PER_ROW) {
    return `too many flavors (max ${IMPORT_MAX_FLAVORS_PER_ROW} per product)`;
  }
  for (const f of flavors) {
    if (f.length > IMPORT_MAX_FLAVOR_LEN) {
      return `flavor exceeds ${IMPORT_MAX_FLAVOR_LEN} characters`;
    }
  }
  // The cost is what the Margin readout is based on; it may never exceed the
  // selling price.
  if (cost !== null && cost !== undefined) {
    if (!Number.isFinite(cost) || cost <= 0) {
      return `invalid cost "${cost}"`;
    }
    if (cost > basePrice) {
      return "cost cannot be higher than the base price";
    }
  }
  // A per-option price may not exceed the base price, and it must name one of
  // the row's options (otherwise the price would never be used).
  for (const [optionName, price] of Object.entries(optionPrices ?? {})) {
    if (!Number.isFinite(price) || price <= 0) {
      return `invalid price for "${optionName}"`;
    }
    if (price > basePrice) {
      return `price for "${optionName}" (${price}) cannot be higher than the base price`;
    }
    if (!flavors.some((f) => f.toLowerCase() === optionName.toLowerCase())) {
      return `price for "${optionName}" but "${optionName}" is not in the Flavors column`;
    }
  }
  return null;
}
