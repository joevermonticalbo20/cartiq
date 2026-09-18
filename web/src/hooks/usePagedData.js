import { useCallback, useEffect, useState } from "react";
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

  const load = useCallback(
    async (targetPage = page) => {
      setState((s) => ({ ...s, loading: true, error: "" }));
      try {
        const res = await api.get(buildPath(targetPage));
        setState({ rows: res.data.data ?? [], meta: res.data.meta ?? null, loading: false, error: "" });
      } catch (err) {
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

  return { ...state, page, gotoPage, refresh: () => load(page) };
}
