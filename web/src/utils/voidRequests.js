/**
 * Fetch pending void requests from the order action queue.
 *
 * This is intentionally order-based, not alert-based. Clicking a void
 * notification marks its VOID_REQUEST alert read; that read state must
 * never make a still-pending order disappear from the owner's queue.
 */
export async function fetchAllVoidRequests(api) {
  const res = await api.get("/orders/pending-void-requests");
  const rows = res.data?.data ?? [];

  return rows
    .filter(
      (order) =>
        order.status === "PAID" && order.voidRequest?.status === "pending"
    )
    .map((order) => {
      const voidRequest = order.voidRequest ?? {};
      const reason = voidRequest.reason || "";
      return {
        id: voidRequest.alertId ?? order.id,
        orderId: order.id,
        requestedByName:
          voidRequest.requestedByName || order.staff?.name || "Staff",
        reason,
        createdAt: voidRequest.requestedAt || order.createdAt,
        payload: JSON.stringify({
          orderId: order.id,
          total: order.total,
          reason,
        }),
      };
    });
}
