import axios from "axios";

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

// Silent access-token refresh. Resolves the fresh token, or null when the
// session is unrecoverable (no/expired refresh token, network down).
function refreshAccessToken() {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const stored = localStorage.getItem("cartiq_refresh_token");
        if (!stored) return null;
        // Bare axios (not the api instance) to avoid interceptor recursion.
        const { data } = await axios.post(`${API_BASE}/auth/refresh`, {
          refreshToken: stored,
        });
        if (!data?.token) return null;
        localStorage.setItem("cartiq_token", data.token);
        if (data.refreshToken) {
          localStorage.setItem("cartiq_refresh_token", data.refreshToken);
        }
        return data.token;
      } catch {
        return null;
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
      // Only a dead refresh (or no refresh token) logs out, like mobile.
      if (error.response?.status === 401 && !isAuthCall && !originalRequest?._retry) {
        if (originalRequest) originalRequest._retry = true;
        const fresh = await refreshAccessToken().catch(() => null);
        if (fresh && originalRequest) {
          originalRequest.headers = {
            ...originalRequest.headers,
            Authorization: `Bearer ${fresh}`,
          };
          return api(originalRequest);
        }
        clearSession();
        redirectToLogin();
      } else if (error.response?.status === 401 && !isAuthCall) {
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
  return config;
});

// --- API Methods ---

/**
 * Generic fetch wrapper
 */
export async function fetchApi(options) {
  try {
    const response = await api.request(options);
    return { success: true, data: response.data };
  } catch (err) {
    const errMsg = err.response?.data?.message || err.message || "Request failed";
    throw new Error(errMsg, { cause: err });
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
