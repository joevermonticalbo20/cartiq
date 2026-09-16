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
 * Validate one parsed import row ({ name, category, basePrice, flavorNames }).
 * Returns null when valid, otherwise the human-readable reason for the
 * row's errors[] entry.
 */
export function validateProductRow({ name, category, basePrice, flavorNames }) {
  if (!name) return 'missing name';
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
  return null;
}
