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

export const toastedAlertIds = new Set();

/**
 * Alert types that already raise their own live toast.
 *
 * A recorded shift is announced by `shift:new` (useShiftNotices), a card
 * registration by `rfid:bound`, a card removal by `rfid:unbound` and every
 * refused tap by its own `rfid:*` event (useRfidEvents). The alert behind each
 * of them still lands in the bell - that is the whole point: every toast has
 * a matching record - but the bell must not say it AGAIN, or one event would
 * raise two toasts on one screen.
 */
export const SELF_ANNOUNCED_ALERT_TYPES = Object.freeze([
  "SHIFT",
  "RFID_BOUND",
  "RFID_UNBOUND",
  "RFID_UNREGISTERED",
  "RFID_CONFLICT",
  "RFID_WRONG_CART",
  "RFID_ALREADY_REGISTERED",
]);

/** True when this alert is already announced by its own live toast. */
export function isSelfAnnouncedAlert(alert) {
  return SELF_ANNOUNCED_ALERT_TYPES.includes(
    String(alert?.type ?? "").toUpperCase(),
  );
}

/** Short affordance for the same target, used as the toast's tooltip. */
export function alertLinkLabel(alert) {
  const t = String(alert?.type ?? "").toLowerCase();
  if (t === "sale" || t === "sales") return "Open sales";
  if (t === "void_request" || t === "void_decision") return "Open void requests";
  if (t === "restock_request" || t === "restock" || t === "low_stock" || t === "critical" || t === "inventory") return "Open inventory";
  return "Open notifications";
}
