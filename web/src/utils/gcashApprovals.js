/**
 * Fetch the GCash orders waiting for the owner's confirmation.
 * The queue is order-based: a notification click may mark the GCASH_CONFIRM
 * alert read, but that must never make an undecided GCash sale disappear
 * from the owner's queue.
 */
export async function fetchPendingGcash(api) {
  const res = await api.get("/orders/pending-gcash");
  const rows = res.data?.data ?? [];
  return Array.isArray(rows) ? rows : [];
}
