// House recipe convention (Pota Fries): what one serving deducts.
// Single source of truth shared by the seed, the backfill script
// (scripts/ensure_recipes.mjs), and the docs — change amounts HERE so every
// cart and every product-flavor follows the same logic.
//
// Units follow the inventory rows: pcs/packs as-is, powders in kg
// (15 g powder per serving = 0.015 kg).
export const POUCH_PER_UNIT = 1;
export const FROZEN_PACKS_PER_UNIT = 0.05;
export const POWDER_KG_PER_UNIT = 0.015; // 15 g per serving

// Generic rows applied to EVERY product (flavor ""): packaging + base.
export function genericRecipeRows() {
  return [
    { itemName: "Pouches", amountPerUnit: POUCH_PER_UNIT },
    { itemName: "Fries (frozen packs)", amountPerUnit: FROZEN_PACKS_PER_UNIT },
  ];
}

// Known flavor -> seasoning powder. Flavors NOT listed here have no
// house powder mapping: the backfill reports them instead of guessing,
// and the dashboard shows them as missing until a recipe is added.
const POWDER_BY_FLAVOR = new Map([
  ["cheese", "Cheese Powder"],
  ["sour cream", "Sour Cream Powder"],
  ["bbq", "BBQ Powder"],
]);

// Recipe rows for one flavor of a product. Returns { rows } or
// { rows: [], unknownFlavor: true } when the flavor has no powder mapping.
export function flavorRecipeRows(flavorName) {
  const powder = POWDER_BY_FLAVOR.get(String(flavorName ?? "").trim().toLowerCase());
  if (!powder) return { rows: [], unknownFlavor: true };
  return { rows: [{ itemName: powder, amountPerUnit: POWDER_KG_PER_UNIT }], unknownFlavor: false };
}

// Full house recipe for one (productName, flavorName) pair: generics plus
// the flavor powder (when known).
export function houseRecipeFor(flavorName) {
  const { rows, unknownFlavor } = flavorRecipeRows(flavorName);
  return { rows: [...genericRecipeRows(), ...rows], unknownFlavor };
}
