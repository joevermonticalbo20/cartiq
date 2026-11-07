/**
 * Fetch all pending void requests across alert pages.
 *
 * The alerts endpoint pages at 100 rows. A single page would silently drop
 * older requests when many unread alerts exist; this walks the page range
 * returned by `meta.totalPages` and keeps the same filter everywhere.
 */
export async function fetchAllVoidRequests(api) {
  const pending = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const res = await api.get(`/alerts?page=${page}&pageSize=100`);
    const rows = res.data?.data ?? [];
    pending.push(
      ...rows.filter(
        (alert) => alert.type === "VOID_REQUEST" && alert.isRead !== true
      )
    );

    const metaTotalPages = Number(res.data?.meta?.totalPages);
    totalPages =
      Number.isInteger(metaTotalPages) && metaTotalPages > 0
        ? metaTotalPages
        : 1;
    if (rows.length === 0) break;
    page += 1;
  }

  return pending;
}
