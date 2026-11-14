import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api.js", () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() },
  API_BASE: "/api",
}));

import api from "../api.js";
import { __emitLiveEvent } from "../hooks/useLiveStream.js";
import {
  __resetLiveData,
  activeCarts,
  invalidateLiveList,
  loadLiveList,
} from "./liveData.js";

describe("the live store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetLiveData();
    api.get.mockImplementation((url) => {
      if (url === "/locations") {
        return Promise.resolve({
          data: {
            data: [
              { id: 1, code: "CART-01", name: "Cart 1", status: "ACTIVE" },
              { id: 2, code: "CART-02", name: "Cart 2", status: "INACTIVE" },
            ],
          },
        });
      }
      if (url === "/auth/staff") {
        return Promise.resolve({ data: { data: [{ id: 2, username: "staff01" }] } });
      }
      if (url === "/devices") {
        return Promise.resolve({ data: { data: [{ id: 21, device_id: "ESP32-A1" }] } });
      }
      return Promise.resolve({ data: {} });
    });
  });

  it("shares one fetch between callers that want it at the same time", async () => {
    const [first, second] = await Promise.all([
      loadLiveList("carts"),
      loadLiveList("carts"),
    ]);
    expect(first).toEqual(second);
    expect(api.get.mock.calls.filter(([url]) => url === "/locations")).toHaveLength(1);
  });

  it("refetches a list when its live frame arrives", async () => {
    await loadLiveList("carts");
    expect(api.get.mock.calls.filter(([url]) => url === "/locations")).toHaveLength(1);

    // The owner deactivated a cart on another screen: the frame arrives and
    // the list is fetched again.
    __emitLiveEvent("locations:updated", { kind: "locations", code: "CART-01" });
    await Promise.resolve();
    await Promise.resolve();
    expect(api.get.mock.calls.filter(([url]) => url === "/locations").length).toBeGreaterThan(1);
  });

  it("refetches a list when it is invalidated by hand", async () => {
    await loadLiveList("staff");
    await invalidateLiveList("staff");
    expect(api.get.mock.calls.filter(([url]) => url === "/auth/staff")).toHaveLength(2);
  });

  it("falls back to the catalog when the owner list is not readable", async () => {
    api.get.mockImplementation((url) => {
      if (url === "/locations") return Promise.reject(new Error("forbidden"));
      if (url === "/catalog") {
        return Promise.resolve({ data: { locations: [{ code: "CART-01", name: "Cart 1" }] } });
      }
      return Promise.resolve({ data: {} });
    });
    const carts = await loadLiveList("carts");
    expect(carts).toEqual([{ code: "CART-01", name: "Cart 1" }]);
  });
});

describe("activeCarts", () => {
  const carts = [
    { code: "CART-01", name: "Cart 1", status: "ACTIVE" },
    { code: "CART-02", name: "Cart 2", status: "INACTIVE" },
  ];

  it("hides a deactivated cart from a dropdown", () => {
    expect(activeCarts(carts).map((c) => c.code)).toEqual(["CART-01"]);
  });

  it("keeps the cart that is currently chosen", () => {
    // An open form must never lose its value, even if that cart was just
    // deactivated.
    expect(activeCarts(carts, "CART-02").map((c) => c.code)).toEqual([
      "CART-01",
      "CART-02",
    ]);
  });

  it("survives a list that has not loaded yet", () => {
    expect(activeCarts(null)).toEqual([]);
    expect(activeCarts(undefined, "CART-01")).toEqual([]);
  });
});
