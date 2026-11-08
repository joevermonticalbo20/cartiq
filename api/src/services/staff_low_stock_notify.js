// Targeted low-stock notifications for the vendor/vendor phone.
//
// All stock-crossing detection stays where it already exists (POS orders,
// IoT readings, manual adjustments). This helper only turns that crossing
// into one targeted alert per assigned STAFF account so their app can notify,
// bubble, and let them request restock immediately.

import { db as prisma } from "../firestore.js";
import { emit } from "../routes/events.js";
import { sendTargetedPush } from "./push.js";
import { lowStockDedupeKey } from "./low_stock_alert.js";

/**
 * Create one unresolved `LOW_STOCK_NOTIFY` alert per active STAFF assigned
 * to [location]. Best-effort; returns the created alerts.
 */
export async function notifyAssignedStaffOfLowStock({
  locationId,
  locationCode,
  inventoryItemId,
  itemName,
  stock,
  threshold,
  unit,
}) {
  const created = [];
  if (!locationId || !inventoryItemId) return created;

  const candidates = await prisma.user.findMany({ where: { locationId } });
  const staff = candidates.filter(
    (u) => u.role === "STAFF" && u.active !== false && Number(u.id) > 0,
  );
  if (!staff.length) return created;

  const dedupeKey = lowStockDedupeKey(locationId, inventoryItemId);
  for (const user of staff) {
    const prior = await prisma.alert.findMany({
      where: {
        type: "LOW_STOCK_NOTIFY",
        userId: user.id,
        ingredientId: inventoryItemId,
        isRead: false,
      },
      take: 10,
      nocache: true,
    });
    if (prior.some((a) => a.locationId === locationId)) continue;

    const alert = await prisma.alert.create({
      data: {
        type: "LOW_STOCK_NOTIFY",
        title: "Low stock",
        message:
          `${itemName} @ ${locationCode} at ${stock} ${unit}` +
          ` (threshold ${threshold}) — tap to request restock.`,
        userId: user.id,
        locationId,
        ingredientId: inventoryItemId,
        ingredientName: itemName,
        requestedBy: user.id,
        requestedByName: user.name ?? user.username ?? null,
        isRead: false,
        payload: JSON.stringify({
          dedupeKey: `${dedupeKey}:staff-${user.id}`,
          inventoryItemId,
          locationId,
          locationCode,
          stock,
          threshold,
          unit,
        }),
      },
    });
    created.push(alert);
    emit("alert:new", {
      id: alert.id,
      type: alert.type,
      userId: alert.userId,
      title: alert.title,
      message: alert.message,
      isRead: alert.isRead === true,
      createdAt: alert.createdAt,
      locationId,
    });
    sendTargetedPush(alert).catch(() => {});
  }
  return created;
}
