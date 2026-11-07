import { describe, it, expect, vi } from "vitest";
import { fetchAllVoidRequests } from "./voidRequests.js";

function order(id, status, voidRequest) {
  return {
    id,
    status,
    total: 30,
    createdAt: "2026-11-07T15:00:00.000Z",
    staff: { name: "Stall Staff 1" },
    voidRequest,
  };
}

describe("fetchAllVoidRequests", () => {
  it("maps pending order voidRequests into page rows and ignores decisions", async () => {
    const api = {
      get: vi.fn().mockResolvedValue({
        data: {
          data: [
            order(20, "PAID", {
              status: "pending",
              alertId: 44,
              requestedByName: "Stall Staff 1",
              reason: "Wrong item punched",
              requestedAt: "2026-11-07T15:12:33.000Z",
            }),
            order(21, "PAID", { status: "approved" }),
            order(22, "VOID", { status: "pending" }),
          ],
        },
      }),
    };

    await expect(fetchAllVoidRequests(api)).resolves.toEqual([
      {
        id: 44,
        orderId: 20,
        requestedByName: "Stall Staff 1",
        reason: "Wrong item punched",
        createdAt: "2026-11-07T15:12:33.000Z",
        payload: JSON.stringify({
          orderId: 20,
          total: 30,
          reason: "Wrong item punched",
        }),
      },
    ]);
    expect(api.get).toHaveBeenCalledWith("/orders/pending-void-requests");
  });

  it("returns an empty list when the endpoint has no rows", async () => {
    const api = { get: vi.fn().mockResolvedValue({ data: { data: [] } }) };
    await expect(fetchAllVoidRequests(api)).resolves.toEqual([]);
  });
});
