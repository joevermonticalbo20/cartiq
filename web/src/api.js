import axios from "axios";
import { toast } from "./components/Toast.jsx";

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
export function setupAuthInterceptor(navigate) {
  navigateFn = navigate;
  if (interceptorInstalled) return;
  interceptorInstalled = true;

  api.interceptors.response.use(
    (response) => response,
    (error) => {
      const originalRequest = error.config;

      // Handle 401 - token expired or invalid: log out and redirect.
      // No refresh-token flow exists, so fail fast instead of queueing.
      if (error.response?.status === 401 && !originalRequest?.url?.startsWith("/login")) {
        localStorage.removeItem("cartiq_token");
        if (navigateFn) {
          navigateFn("/login", { replace: true });
        }
        return Promise.reject(error);
      }

      // Handle other errors - show toast
      if (error.response) {
        const errorMsg =
          error.response.data?.message ||
          error.response.data?.error ||
          "An unexpected error occurred";

        // Don't show toast for 401s being redirected to login
        if (!(error.response.status === 401 && !originalRequest?.url?.startsWith("/login"))) {
          toast(errorMsg, "error");
        }
      }

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
    data: body !== undefined ? JSON.stringify(body) : undefined,
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
    data: body !== undefined ? JSON.stringify(body) : undefined,
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
    data: body !== undefined ? JSON.stringify(body) : undefined,
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
