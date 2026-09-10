import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { usePagedData } from "./usePagedData.js";

vi.mock("../api.js", () => {
  return {
    default: {
      get: vi.fn(),
    },
    getErrorMessage: (err, fallback) => err?.message || fallback,
  };
});

import api from "../api.js";

const page1 = {
  data: [{ id: 1 }, { id: 2 }],
  meta: { total: 4, page: 1, pageSize: 2, totalPages: 2 },
};
const page2 = {
  data: [{ id: 3 }, { id: 4 }],
  meta: { total: 4, page: 2, pageSize: 2, totalPages: 2 },
};

describe("usePagedData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads page 1 on mount", async () => {
    api.get.mockResolvedValue({ data: page1 });
    const { result } = renderHook(() => usePagedData((p) => `/x?page=${p}`, []));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect(result.current.meta.totalPages).toBe(2);
    expect(result.current.error).toBe("");
    expect(api.get).toHaveBeenCalledWith("/x?page=1");
  });

  it("surfaces server errors instead of empty rows", async () => {
    api.get.mockRejectedValue(new Error("boom-500"));
    const { result } = renderHook(() => usePagedData((p) => `/x?page=${p}`, []));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("boom-500");
    expect(result.current.rows).toEqual([]);
  });

  it("gotoPage loads the requested page", async () => {
    api.get.mockImplementation((url) =>
      Promise.resolve({ data: url.includes("page=2") ? page2 : page1 })
    );
    const { result } = renderHook(() => usePagedData((p) => `/x?page=${p}`, []));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      result.current.gotoPage(2);
    });
    await waitFor(() => expect(result.current.page).toBe(2));
    expect(result.current.rows).toEqual([{ id: 3 }, { id: 4 }]);
  });

  it("refresh reloads the current page", async () => {
    api.get.mockResolvedValue({ data: page1 });
    const { result } = renderHook(() => usePagedData((p) => `/x?page=${p}`, []));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const calls = api.get.mock.calls.length;
    await act(async () => {
      result.current.refresh();
    });
    expect(api.get.mock.calls.length).toBeGreaterThan(calls);
  });

  it("resets to page 1 when deps change", async () => {
    let filter = "a";
    api.get.mockResolvedValue({ data: page1 });
    const { result, rerender } = renderHook(
      ({ f }) => usePagedData((p) => `/x?page=${p}&f=${f}`, [f]),
      { initialProps: { f: filter } }
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    filter = "b";
    rerender({ f: filter });
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith("/x?page=1&f=b")
    );
    expect(result.current.page).toBe(1);
  });
});
