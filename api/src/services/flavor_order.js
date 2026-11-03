// Flavor/option display order.
//
// The Pota Fries menu stores SIZES as flavor options (Medium / Large /
// XL 40 / XL 50), so plain alphabetical order showed them as Large, Medium,
// XL … — wrong on the POS card, the web badges, and every picker. Rank the
// size family first (Medium < Large < XL) with a natural compare inside a
// rank ("XL 40" before "XL 50"), then everything else alphabetically.
const SIZE_RANK = (name) => {
  const n = String(name ?? "").trim().toLowerCase();
  if (n.startsWith("medium")) return 0;
  if (n.startsWith("large")) return 1;
  if (n.startsWith("xl")) return 2;
  return 3;
};

export function compareFlavorNames(a, b) {
  const ra = SIZE_RANK(a);
  const rb = SIZE_RANK(b);
  if (ra !== rb) return ra - rb;
  return String(a ?? "").localeCompare(String(b ?? ""), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

/** Sort a copy of a flavor row list by the rule above. */
export function sortFlavorRows(rows, nameOf = (r) => r?.name) {
  return [...(rows ?? [])].sort((x, y) => compareFlavorNames(nameOf(x), nameOf(y)));
}
