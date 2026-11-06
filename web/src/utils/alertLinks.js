/**
 * Where a notification takes the user. One mapping for the bell dropdown,
 * the notifications page, the live toasts and the browser notifications.
 * Unknown/new types land on the full notifications list rather than
 * nowhere.
 */
export function alertLink(alert) {
  const t = String(alert?.type ?? "").toLowerCase();
  if (t === "sale" || t === "sales") return "/sales";
  if (t === "void_request" || t === "void_decision") return "/sales/void-requests";
  if (t === "restock_request" || t === "restock") return "/inventory";
  if (t === "low_stock" || t === "critical" || t === "inventory") return "/inventory";
  return "/notifications";
}

/** Short affordance for the same target, used as the toast's tooltip. */
export function alertLinkLabel(alert) {
  const t = String(alert?.type ?? "").toLowerCase();
  if (t === "sale" || t === "sales") return "Open sales";
  if (t === "void_request" || t === "void_decision") return "Open void requests";
  if (t === "restock_request" || t === "restock" || t === "low_stock" || t === "critical" || t === "inventory") return "Open inventory";
  return "Open notifications";
}
