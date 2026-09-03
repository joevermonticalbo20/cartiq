import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useApiData, useApiMutation, useDebounce, useLocalStorage } from "./useApi.js";

vi.mock("../api.js", () => {
  return {
    default: {
      get: vi.fn(),
      post: vi.fn(),
    },
  };
});

import api from "../api.js";

describe("useApiData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts with loading=true and null data", async () => {
    api.get.mockResolvedValue({ data: { items: [] } });
    const { result } = renderHook(() => useApiData("/test"));
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBe(null);
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it("populates data on successful fetch", async () => {
    api.get.mockResolvedValue({ data: { items: [1, 2, 3] } });
    const { result } = renderHook(() => useApiData("/test"));
    await waitFor(() => expect(result.current.data).toEqual({ items: [1, 2, 3] }));
    expect(result.current.error).toBe(null);
  });

  it("sets error on failed fetch", async () => {
    api.get.mockRejectedValue(new Error("Network error"));
    const { result } = renderHook(() => useApiData("/test"));
    await waitFor(() => expect(result.current.error).toBe("Network error"));
  });

  it("refetch triggers a new fetch", async () => {
    api.get.mockResolvedValueOnce({ data: { v: 1 } });
    api.get.mockResolvedValueOnce({ data: { v: 2 } });
    const { result } = renderHook(() => useApiData("/test"));
    await waitFor(() => expect(result.current.data).toEqual({ v: 1 }));
    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.data).toEqual({ v: 2 });
  });
});

describe("useApiMutation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("mutate posts data and returns response", async () => {
    api.post.mockResolvedValue({ data: { id: 1, ok: true } });
    const { result } = renderHook(() => useApiMutation("POST"));
    let response;
    await act(async () => {
      response = await result.current.mutate("/test", { x: 1 });
    });
    expect(api.post).toHaveBeenCalledWith("/test", { x: 1 });
    expect(response).toEqual({ id: 1, ok: true });
  });

  it("captures error on failed mutation", async () => {
    api.post.mockRejectedValue(new Error("Bad request"));
    const { result } = renderHook(() => useApiMutation("POST"));
    await act(async () => {
      await expect(result.current.mutate("/test")).rejects.toThrow();
    });
    expect(result.current.error).toBe("Bad request");
  });
});

describe("useDebounce", () => {
  it("returns initial value immediately", () => {
    const { result } = renderHook(() => useDebounce("hello", 300));
    expect(result.current).toBe("hello");
  });
});

describe("useLocalStorage", () => {
  it("returns initial value when localStorage is empty", () => {
    const { result } = renderHook(() => useLocalStorage("test-key", "default"));
    expect(result.current[0]).toBe("default");
  });

  it("persists value to localStorage on set", () => {
    const { result } = renderHook(() => useLocalStorage("test-key", "default"));
    act(() => {
      result.current[1]("new value");
    });
    expect(localStorage.setItem).toHaveBeenCalled();
  });
});
