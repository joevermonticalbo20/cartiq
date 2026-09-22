import axios from "axios";
import { getFriendlyError } from "./utils/errors.js";

// --- Configuration ---
const API_BASE = import.meta.env.VITE_API_BASE || "/api";
const API_TIMEOUT = 10000;

// --- API Client ---
const api = axios.create({
  baseURL: API_BASE,
  timeout: API_TIMEOUT,
  headers: {
    "Content-Type": "application/json",
  },
});

let navigateFn = null;
let interceptorInstalled = false;

// Called once at app startup to wire up the navigate function and response interceptor
// Prevent duplicate redirects when multiple concurrent 401s occur.
let redirecting = false;

// Shared in-flight refresh so concurrent 401s make exactly one POST.
// Rotation invalidates the old refresh token, so a second POST would fail.
let refreshPromise = null;

function clearSession() {
  localStorage.removeItem("cartiq_token");
  localStorage.removeItem("cartiq_refresh_token");
}

function redirectToLogin() {
  if (!redirecting && navigateFn) {
    redirecting = true;
    navigateFn("/login", { replace: true });
    setTimeout(() => (redirecting = false), 2000);
  }
}

// Silent access-token refresh. Resolves one of:
//   { token }        - recovered; caller should retry once
//   { fatal: true }  - server explicitly rejected the session (400/401/403/404
//                      or no stored token): caller must log out
//   { fatal: false } - network/timeout/5xx: transient, stay logged in and
//                      let the caller surface its own error
function refreshAccessToken() {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const stored = localStorage.getItem("cartiq_refresh_token");
        if (!stored) return { fatal: true };
        // Bare axios (not the api instance) to avoid interceptor recursion.
        const { data } = await axios.post(`${API_BASE}/auth/refresh`, {
          refreshToken: stored,
        });
        if (!data?.token) return { fatal: true };
        localStorage.setItem("cartiq_token", data.token);
        if (data.refreshToken) {
          localStorage.setItem("cartiq_refresh_token", data.refreshToken);
        }
        return { token: data.token };
      } catch (err) {
        const status = err.response?.status;
        if (status === 400 || status === 401 || status === 403 || status === 404) {
          return { fatal: true };
        }
        return { fatal: false };
      } finally {
        refreshPromise = null;
      }
    })();
  }
  return refreshPromise;
}

export function setupAuthInterceptor(navigate) {
  navigateFn = navigate;
  if (interceptorInstalled) return;
  interceptorInstalled = true;

  api.interceptors.response.use(
    (response) => response,
    async (error) => {
      const originalRequest = error.config;
      // Auth calls manage their own failures (login shows its error box,
      // refresh has no session to recover) — never retry or redirect them.
      // Note: config.url is the endpoint path ("/auth/login"), so match
      // by inclusion, not by "/login" prefix (which never matches).
      const isAuthCall =
        originalRequest?.url?.includes("/auth/login") ||
        originalRequest?.url?.includes("/auth/refresh");

      // 401 on an app request: try one silent refresh, then retry once.
      // Logout happens ONLY on explicit session rejection. Transient
      // refresh failures (offline/timeout/5xx) keep the session and let
      // the caller show its own error, like mobile. And when the refresh
      // DID yield a fresh token but the retried call still 401s, that is an
      // endpoint-level rejection (wrong credential type, disabled feature) —
      // never a dead session, so the session must survive it too.
      if (error.response?.status === 401 && !isAuthCall && !originalRequest?._retry) {
        if (originalRequest) originalRequest._retry = true;
        const outcome = await refreshAccessToken().catch(() => ({ fatal: false }));
        if (outcome?.token && originalRequest) {
          originalRequest.headers = {
            ...originalRequest.headers,
            Authorization: `Bearer ${outcome.token}`,
          };
          originalRequest._refreshed = true;
          return api(originalRequest);
        }
        if (outcome?.fatal) {
          clearSession();
          redirectToLogin();
        }
      } else if (error.response?.status === 401 && !isAuthCall && !originalRequest?._refreshed) {
        clearSession();
        redirectToLogin();
      }

      // NOTE: no global error toast here on purpose. Every caller owns its
      // error UI (error boxes, empty states, or an explicit toast call), and
      // background reads deliberately swallow failures. A global toast caused
      // phantom "error" popups on page open (e.g. staff hitting owner-only
      // endpoints in the background, SensorPanel's 5s poll) plus double
      // reporting next to each page's own error display.
      return Promise.reject(error);
    }
  );
}

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("cartiq_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  // FormData uploads (Data Hub .xlsx import) need the browser's multipart
  // boundary. The instance default is application/json, so drop it here and
  // let axios set multipart/form-data automatically.
  if (config.data instanceof FormData && config.headers) {
    delete config.headers["Content-Type"];
  }
  return config;
});

// --- API Methods ---

/**
 * Normalized API error. Carries the server's message plus the status,
 * code, and raw body so callers never have to dig through axios shapes.
 * Use getErrorMessage() to render it with a fallback.
 */
export class ApiError extends Error {
  constructor(message, { status = null, code = null, data = null, cause = null } = {}) {
    super(message, { cause });
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

/**
 * Safe display text for a caught request error. Uses the shared formatter so
 * Data Hub and other callers cannot render raw axios or database internals.
 */
export function getErrorMessage(err, fallback = "Request failed") {
  if (err instanceof ApiError) return getFriendlyError(err, fallback);
  return fallback;
}

/**
 * Generic fetch wrapper with one cold-start retry: Render free sleeps after
 * idle (~50s cold start vs 10s timeout), so the first GET after idle almost
 * always times out. Retry idempotent GETs once; never auto-retry POST/
 * PATCH/PUT/DELETE (writes rely on clientRef idempotency, not retries).
 */
export async function fetchApi(options) {
  const isGet = String(options?.method ?? "GET").toUpperCase() === "GET";
  try {
    const response = await api.request(options);
    return { success: true, data: response.data };
  } catch (err) {
    const timedOut = !err.response && (err.code === "ECONNABORTED" || /timeout/i.test(err.message ?? ""));
    let finalErr = err;
    if (isGet && timedOut && !options._retried) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const response = await api.request({ ...options, _retried: true });
        return { success: true, data: response.data };
      } catch (retryErr) {
        finalErr = retryErr;
      }
    }
    if (finalErr instanceof ApiError) throw finalErr;
    const status = finalErr.response?.status ?? null;
    const data = finalErr.response?.data ?? null;
    const code = data?.code ?? data?.error ?? null;
    const errMsg =
      data?.error || data?.message || finalErr.message || "Request failed";
    throw new ApiError(errMsg, { status, code, data, cause: finalErr });
  }
}

/**
 * GET request
 */
export function get(endpoint, config = {}) {
  return fetchApi({ method: "GET", url: endpoint, ...config });
}

/**
 * POST request
 */
export function post(endpoint, body, config = {}) {
  return fetchApi({
    method: "POST",
    url: endpoint,
    data: body,
    ...config,
  });
}

/**
 * PUT request
 */
export function put(endpoint, body, config = {}) {
  return fetchApi({
    method: "PUT",
    url: endpoint,
    data: body,
    ...config,
  });
}

/**
 * PATCH request
 */
export function patch(endpoint, body, config = {}) {
  return fetchApi({
    method: "PATCH",
    url: endpoint,
    data: body,
    ...config,
  });
}

/**
 * DELETE request
 */
export function del(endpoint, config = {}) {
  return fetchApi({ method: "DELETE", url: endpoint, ...config });
}

// --- Utils ---

export function isTokenExpired(token) {
  if (!token) return true;
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    return payload.exp * 1000 < Date.now();
  } catch {
    return true;
  }
}

export function getTokenExpiry(token) {
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    return payload.exp * 1000;
  } catch {
    return null;
  }
}

const apiObj = { get, post, put, patch, del, fetchApi, isTokenExpired, getTokenExpiry, API_BASE };
export default apiObj;
export { API_BASE };
