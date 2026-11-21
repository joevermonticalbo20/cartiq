/**
 * Where a notification takes the user. One mapping for the bell dropdown,
 * the notifications page, the live toasts and the browser notifications.
 * Unknown/new types land on the full notifications list rather than
 * nowhere.
 */
export function alertLink(alert) {
  const t = String(alert?.type ?? "").toLowerCase();
  const payload = readPayload(alert?.payload);
  const params = new URLSearchParams();
  const orderId = alert?.orderId ?? payload.orderId ?? payload.order_id;
  const locationCode =
    alert?.locationCode ?? payload.locationCode ?? locationFromMessage(alert?.message);
  const itemName =
    alert?.ingredientName ??
    alert?.itemName ??
    payload.ingredientName ??
    payload.itemName ??
    itemFromMessage(alert?.message);

  if (t === "sale" || t === "sales") {
    if (locationCode) params.set("cart", locationCode);
    if (orderId != null) params.set("orderId", orderId);
    return withParams("/sales", params);
  }
  if (t === "void_request" || t === "void_decision") {
    if (orderId != null) params.set("orderId", orderId);
    return withParams("/sales/void-requests", params);
  }
  if (t === "gcash_confirm" || t === "gcash_decision") {
    if (orderId != null) params.set("orderId", orderId);
    return withParams("/sales/gcash-approvals", params);
  }
  if (t === "restock_request" || t === "restock") {
    if (locationCode) params.set("cart", locationCode);
    if (alert?.id != null) params.set("requestId", alert.id);
    if (itemName) params.set("itemName", itemName);
    return withParams("/inventory", params);
  }
  if (t === "low_stock" || t === "critical" || t === "inventory") {
    if (locationCode) params.set("cart", locationCode);
    if (itemName) params.set("itemName", itemName);
    return withParams("/inventory", params);
  }
  if (t === "absence") return "/staff";
  return "/notifications";
}

function readPayload(payload) {
  if (payload && typeof payload === "object") return payload;
  if (typeof payload !== "string") return {};
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function locationFromMessage(message) {
  return String(message ?? "").match(/@\s*([A-Z0-9-]+)/i)?.[1] ?? null;
}

function itemFromMessage(message) {
  const match = String(message ?? "").match(/^\s*(.+?)\s*@\s*[A-Z0-9-]+/i);
  return match?.[1]?.trim() || null;
}

function withParams(path, params) {
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export const toastedAlertIds = new Set();

/**
 * Alert types that already raise their own live toast.
 *
 * A recorded shift is announced by `shift:new` (useShiftNotices), a card
 * registration by `rfid:bound`, a card removal by `rfid:unbound` and every
 * refused tap by its own `rfid:*` event (useRfidEvents). An OWNER_NOTICE
 * (owner phones popped for a recorded tap) is the server's durable copy of
 * exactly those events. The alert behind each of them still lands in the
 * bell - that is the whole point: every toast has a matching record - but the
 * bell must not say it AGAIN, or one event would raise two toasts on one screen.
 */
export const SELF_ANNOUNCED_ALERT_TYPES = Object.freeze([
  "SHIFT",
  "OWNER_NOTICE",
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
  if (t === "gcash_confirm" || t === "gcash_decision") return "Open GCash approvals";
  if (t === "restock_request" || t === "restock" || t === "low_stock" || t === "critical" || t === "inventory") return "Open inventory";
  if (t === "absence") return "Open staff";
  return "Open notifications";
}
