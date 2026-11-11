import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

vi.mock("../api.js", () => ({
  default: { get: vi.fn() },
  API_BASE: "/api",
}));

import api from "../api.js";
import { useCatalogVersion, __resetCatalogVersionProbe } from "./useCatalogVersion.js";

/**
 * The catalog-version probe is the safety net under the live stream: the
 * stream pauses while the tab is hidden, so a change made in the meantime
 * can only be noticed by comparing a version counter.
 */
describe("useCatalogVersion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetCatalogVersionProbe();
    api.get.mockResolvedValue({ data: { version: 1 } });
  });

  it("asks for the version with caching off", async () => {
    renderHook(() => useCatalogVersion(() => {}));
    await vi.waitFor(() =>
      expect(api.get).toHaveBeenCalledWith("/catalog/version", { cacheTtl: 0 })
    );
  });

  it("stays quiet on the first probe - the page just loaded that data", async () => {
    const onChange = vi.fn();
    renderHook(() => useCatalogVersion(onChange));
    await vi.waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("fires when the version moved", async () => {
    const onChange = vi.fn();
    renderHook(() => useCatalogVersion(onChange));
    await vi.waitFor(() => expect(api.get).toHaveBeenCalled());

    api.get.mockResolvedValue({ data: { version: 2 } });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith(2));
  });

  it("stays quiet while the version is unchanged", async () => {
    const onChange = vi.fn();
    renderHook(() => useCatalogVersion(onChange));
    await vi.waitFor(() => expect(api.get).toHaveBeenCalled());

    api.get.mockResolvedValue({ data: { version: 1 } });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores a broken probe instead of throwing", async () => {
    const onChange = vi.fn();
    api.get.mockRejectedValue(new Error("offline"));
    renderHook(() => useCatalogVersion(onChange));
    await vi.waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(onChange).not.toHaveBeenCalled();
  });
});
