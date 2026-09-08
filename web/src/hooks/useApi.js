import { useState, useEffect, useCallback, useRef } from "react";
import api from "../api.js";

/**
 * useApiData - Custom hook for fetching and managing API data
 * @param {string} endpoint - API endpoint to fetch
 * @param {object} options - { immediate: bool, onSuccess, onError }
 */
export function useApiData(endpoint, options = {}) {
  const { immediate = true, onSuccess, onError } = options;

  // Latest callbacks via ref so `fetch` stays stable on `endpoint` only.
  const callbacks = useRef({ onSuccess, onError });
  useEffect(() => {
    callbacks.current = { onSuccess, onError };
  }, [onSuccess, onError]);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(immediate);
  const [error, setError] = useState(null);

  const fetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.get(endpoint);
      const result = response.data;
      setData(result);
      callbacks.current.onSuccess?.(result);
      return result;
    } catch (err) {
      const message = err.message || "Failed to fetch data";
      setError(message);
      callbacks.current.onError?.(err);
      return null;
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => {
    if (immediate) {
      setTimeout(() => fetch(), 0);
    }
  }, [fetch, immediate]);

  return { data, loading, error, refetch: fetch, setData };
}

/**
 * useApiMutation - Custom hook for POST/PUT/PATCH/DELETE operations
 * @param {string} method - HTTP method
 * @param {string} endpoint - API endpoint
 */
export function useApiMutation(method = "POST") {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const mutate = useCallback(
    async (endpoint, body) => {
      setLoading(true);
      setError(null);
      try {
        const response = await api[method.toLowerCase()](endpoint, body);
        return response.data;
      } catch (err) {
        const message = err.message || `Failed to ${method.toLowerCase()} data`;
        setError(message);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [method]
  );

  return { mutate, loading, error, reset: () => setError(null) };
}

/**
 * useDebounce - Debounce a value
 */
export function useDebounce(value, delay = 300) {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}

/**
 * useLocalStorage - Persist state to localStorage
 */
export function useLocalStorage(key, initialValue) {
  const [storedValue, setStoredValue] = useState(() => {
    try {
      const item = localStorage.getItem(key);
      return item ? JSON.parse(item) : initialValue;
    } catch {
      return initialValue;
    }
  });

  const setValue = useCallback(
    (value) => {
      const valueToStore = value instanceof Function ? value(storedValue) : value;
      setStoredValue(valueToStore);
      localStorage.setItem(key, JSON.stringify(valueToStore));
    },
    [key, storedValue]
  );

  return [storedValue, setValue];
}
