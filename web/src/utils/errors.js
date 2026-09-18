/**
 * Friendly error text for request failures. Server-provided messages for
 * 4xx (400/404/409) surface verbatim — they name the exact problem
 * (taken name, blocked delete, missing record). Connection problems,
 * permission denials, and server errors get plain-language text instead of
 * raw axios internals ("Request failed with status code 500").
 *
 * Pure function over the error shape (works with ApiError, axios errors,
 * and plain Errors) so callers never dig through error shapes themselves.
 */
export function getFriendlyError(err, fallback = "Request failed") {
  const status = err?.status ?? err?.response?.status ?? null;
  const serverMsg =
    err?.data?.error ||
    err?.data?.message ||
    err?.response?.data?.error ||
    err?.response?.data?.message ||
    "";
  if (serverMsg) {
    // Specific 4xx messages name the problem — keep them, except permission
    // denials which get the plain-language version below.
    if (status !== 403) return serverMsg;
  }

  const raw = String(err?.message ?? "");
  const timedOut = !err?.response && (err?.code === "ECONNABORTED" || /timeout/i.test(raw));
  const looksOffline =
    timedOut || /network error|failed to fetch/i.test(raw) || err?.code === "ERR_NETWORK";
  if (!status && !serverMsg && !raw && !looksOffline && !err?.response) {
    return fallback;
  }
  if (!status && (looksOffline || !err?.response)) {
    // No response at all: offline, DNS, CORS, or the Render free cold start
    // (first request after idle can exceed the 10s client timeout — retry warm).
    if (!serverMsg && (timedOut || /network error|failed to fetch/i.test(raw) || raw === "")) {
      return "Cannot reach the server. Check your connection — the first load after idle can take about a minute, then try again.";
    }
    // Plain local errors (e.g. validation throws in tests) surface as-is.
    if (raw && !/status code \d+|request failed/i.test(raw)) return raw;
    return "Cannot reach the server. Check your connection — the first load after idle can take about a minute, then try again.";
  }
  if (status === 403) return "You don't have permission to do that.";
  if (status === 404) return "Not found. It may have been deleted.";
  if (status !== null && status >= 500) return "The server had a problem. Try again in a bit.";
  if (raw && !/status code \d+/i.test(raw)) return raw;
  return fallback;
}
