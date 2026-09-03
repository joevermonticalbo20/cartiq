export const EXPENSE_CATEGORY_COLORS = {
  "Supplies": "#8B5CF6",
  "LPG/Gas": "#F59E0B",
  "Maintenance": "#10B981",
  "Fees/Rent": "#3B82F6",
  "Other": "#6B7280",
};

export function expenseCategoryColor(category) {
  return EXPENSE_CATEGORY_COLORS[category] || "#6B7280";
}