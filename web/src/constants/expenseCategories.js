// Brand-family ramps (charcoal / red / amber) - no Tailwind rainbow.
export const EXPENSE_CATEGORY_COLORS = {
  "Supplies": "#E73631",
  "LPG/Gas": "#ECC242",
  "Maintenance": "#0A0908",
  "Fees/Rent": "#C72824",
  "Other": "#9CA3AF",
};

export function expenseCategoryColor(category) {
  return EXPENSE_CATEGORY_COLORS[category] || "#9CA3AF";
}