import { describe, it, expect, vi } from "vitest";
import { fetchAllVoidRequests } from "./voidRequests.js";

describe("fetchAllVoidRequests", () => {
  it("walks every alerts page and keeps only pending VOID_REQUEST rows", async () => {
    const api = {
      get: vi.fn()
        .mockResolvedValueOnce({
          data: {
            data: [
              { id: 1, type: "VOID_REQUEST", isRead: false },
              { id: 2, type: "SALE", isRead: false },
            ],
            meta: { total: 3, page: 1, pageSize: 100, totalPages: 2 },
          },
        })
        .mockResolvedValueOnce({
          data: {
            data: [{ id: 3, type: "VOID_REQUEST", isRead: false }],
            meta: { total: 3, page: 2, pageSize: 100, totalPages: 2 },
          },
        }),
    };

    await expect(fetchAllVoidRequests(api)).resolves.toEqual([
      { id: 1, type: "VOID_REQUEST", isRead: false },
      { id: 3, type: "VOID_REQUEST", isRead: false },
    ]);
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(api.get).toHaveBeenNthCalledWith(1, "/alerts?page=1&pageSize=100");
    expect(api.get).toHaveBeenNthCalledWith(2, "/alerts?page=2&pageSize=100");
  });

  it("still works when the API omits meta", async () => {
    const api = {
      get: vi.fn().mockResolvedValueOnce({
        data: { data: [{ id: 9, type: "VOID_REQUEST", isRead: true }] },
      }),
    };

    await expect(fetchAllVoidRequests(api)).resolves.toEqual([]);
    expect(api.get).toHaveBeenCalledTimes(1);
  });
});
