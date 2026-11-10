import { useCallback, useEffect, useRef, useState } from "react";
import api from "../api.js";
import { getFriendlyError } from "../utils/errors.js";

/**
 * Paged data fetcher for endpoints returning { data, meta }.
 * buildPath(page) must return the request path for the given page.
 * Refetches whenever any dep in `deps` changes.
 */
export function usePagedData(buildPath, deps = []) {
  const [state, setState] = useState({
    rows: [],
    meta: null,
    loading: true,
    error: "",
  });

  const [page, setPage] = useState(1);

  // Only the newest request may write to the state. Without this, a slow
  // page-1 request that resolves after a fast page-2 request overwrites the
  // newer rows (the classic out-of-order response race).
  const requestId = useRef(0);

  const load = useCallback(
    async (targetPage) => {
      const id = ++requestId.current;
      setState((s) => ({ ...s, loading: true, error: "" }));
      try {
        const res = await api.get(buildPath(targetPage));
        if (id !== requestId.current) return; // a newer request won
        setState({ rows: res.data.data ?? [], meta: res.data.meta ?? null, loading: false, error: "" });
      } catch (err) {
        if (id !== requestId.current) return; // a newer request won
        setState((s) => ({
          ...s,
          loading: false,
          error: getFriendlyError(err, "Failed to load data"),
        }));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    deps
  );

  useEffect(() => {
    load(1);
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const gotoPage = (p) => {
    setPage(p);
    load(p);
  };

  // The page is always passed explicitly: a default of `page` would capture
  // a stale value from the closure.
  return { ...state, page, gotoPage, refresh: () => load(page) };
}
