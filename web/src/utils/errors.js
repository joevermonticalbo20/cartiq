/**
 * Friendly error text for request failures. Safe, human-readable 4xx
 * messages surface verbatim; transport, database, and axios internals do
 * not. Callers can still provide an operation-specific fallback.
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
  if (serverMsg && isSafeServerMessage(serverMsg)) {
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
    // Plain local errors surface as-is; unsafe transport internals use the
    // caller's operation-specific fallback.
    if (raw && isSafeLocalMessage(raw)) return raw;
    if (raw) return fallback;
    return "Cannot reach the server. Check your connection — the first load after idle can take about a minute, then try again.";
  }
  if (status === 401) return "Your session may have expired. Please sign in again.";
  if (status === 403) return "You don't have permission to do that.";
  if (status === 408 || timedOut) return "That took too long. Check your connection and try again.";
  if (status === 429) return "Too many requests. Wait a moment, then try again.";
  if (status === 404) return "Not found. It may have been deleted.";
  if (status !== null && status >= 500) return "The server had a problem. Try again in a bit.";
  if (raw && isSafeLocalMessage(raw)) return raw;
  return fallback;
}

function isSafeServerMessage(message) {
  const text = String(message).trim();
  if (!text || text.length > 240) return false;
  return !/(axioserror|request failed|status code \d+|econnaborted|sql(state)?|sqlite|firestore|firebase|constraint|syntax error|stack trace| at [\w./\\:-]+\(?)/i.test(text);
}

function isSafeLocalMessage(message) {
  return !/(axioserror|request failed|status code \d+|econnaborted|network error|failed to fetch|sql(state)?|sqlite|firestore|firebase|constraint|syntax error)/i.test(message);
}
