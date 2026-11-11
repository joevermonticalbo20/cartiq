import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Outlet } from "react-router-dom";
import { ToastProvider } from "../components/Toast.jsx";
import { LIVE_EVENTS, __emitLiveEvent } from "../hooks/useLiveStream.js";

vi.mock("../api.js", () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
  API_BASE: "/api",
  getErrorMessage: (err, fallback) => err?.message || fallback,
}));

import api from "../api.js";
import InventoryPage from "./InventoryPage.jsx";

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <ToastProvider>
        <Routes>
          <Route
            element={<Outlet context={{ user: { name: "Owner", role: "OWNER" } }} />}
          >
            <Route element={<InventoryPage />} path="/" />
          </Route>
        </Routes>
      </ToastProvider>
    </MemoryRouter>
  );
}

describe("InventoryPage loading/error states", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows a loading skeleton while fetching", () => {
    api.get.mockReturnValue(new Promise(() => {}));
    const { container } = renderPage();
    expect(container.querySelector(".skel")).not.toBeNull();
    expect(screen.getByRole("region", { name: "Loading mobile restock requests" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Loading prep forecast" })).toBeInTheDocument();
    expect(screen.queryByText("No carts configured")).toBeNull();
  });

  it("shows the empty state on success with zero carts", async () => {
    api.get.mockImplementation((url) => {
      if (url === "/inventory") return Promise.resolve({ data: { locations: [] } });
      return Promise.resolve({ data: null });
    });
    renderPage();
    expect(await screen.findByText("No carts configured")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows an error with retry on 500, not the empty state", async () => {
    api.get.mockImplementation((url) => {
      if (url === "/inventory") {
        return Promise.reject(new Error("explode"));
      }
      return Promise.resolve({ data: null });
    });
    renderPage();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("explode")).toBeInTheDocument();
    expect(screen.queryByText("No carts configured")).toBeNull();
  });

  it("retry re-fetches after a failure", async () => {
    let calls = 0;
    api.get.mockImplementation((url) => {
      if (url === "/inventory") {
        calls++;
        if (calls === 1) return Promise.reject(new Error("down"));
        return Promise.resolve({ data: { locations: [] } });
      }
      return Promise.resolve({ data: null });
    });
    renderPage();
    const alert = await screen.findByRole("alert");
    const callsBeforeRetry = api.get.mock.calls.length;
    fireEvent.click(within(alert).getByText("Retry"));
    expect(await screen.findByText("No carts configured")).toBeInTheDocument();
    // Retry fires a fresh round of fetches.
    expect(api.get.mock.calls.length).toBeGreaterThan(callsBeforeRetry);
  });

  it("shows what consumes each stock item", async () => {
    api.get.mockImplementation((url) => {
      if (url === "/inventory") {
        return Promise.resolve({
          data: {
            locations: [
              {
                code: "CART-01",
                name: "Cart 1",
                items: [
                  { id: 1, name: "Cheese Powder", stock: 3, threshold: 1, unit: "kg", source: "MANUAL", status: "ok" },
                ],
              },
            ],
          },
        });
      }
      if (url === "/products") {
        return Promise.resolve({
          data: {
            data: [
              {
                id: 5,
                name: "Flavored Fries",
                flavors: [{ id: 1, name: "Cheese", recipes: [{ itemName: "Cheese Powder", amountPerUnit: 0.03 }] }],
              },
            ],
          },
        });
      }
      return Promise.resolve({ data: null });
    });
    renderPage();
    expect(await screen.findByText(/Used by Flavored Fries \(Cheese\)/)).toBeInTheDocument();
  });

  it("groups a product's sizes into one Used by label", async () => {
    const sizes = ["Medium", "Large", "XL 40", "XL 50"];
    api.get.mockImplementation((url) => {
      if (url === "/inventory") {
        return Promise.resolve({
          data: {
            locations: [
              {
                code: "CART-01",
                name: "Cart 1",
                items: [
                  { id: 1, name: "Fries (frozen packs)", stock: 3, threshold: 1, unit: "packs", source: "MANUAL", status: "ok" },
                ],
              },
            ],
          },
        });
      }
      if (url === "/products") {
        return Promise.resolve({
          data: {
            data: [
              {
                id: 8,
                name: "BBQ Fries",
                active: true,
                // Fallback rows: already copied into every size, so they must
                // not add a second bare "BBQ Fries" label.
                recipes: [{ itemName: "Fries (frozen packs)", amountPerUnit: 0.05 }],
                flavors: sizes.map((size, index) => ({
                  id: 13 + index,
                  name: size,
                  recipes: [
                    { itemName: `Pouch ${size.startsWith("XL") ? "XL" : size}`, amountPerUnit: 1 },
                    { itemName: "Fries (frozen packs)", amountPerUnit: 0.05 },
                  ],
                })),
              },
            ],
          },
        });
      }
      return Promise.resolve({ data: null });
    });
    renderPage();
    expect(
      await screen.findByText("Used by BBQ Fries (Medium, Large, XL 40, XL 50)")
    ).toBeInTheDocument();
    expect(screen.queryByText(/Used by BBQ Fries$/)).toBeNull();
  });

  it("pulls the stock and the Used by map again when something changes live", async () => {
    api.get.mockImplementation((url) => {
      if (url === "/inventory") {
        return Promise.resolve({
          data: {
            locations: [
              {
                code: "CART-01",
                name: "Cart 1",
                items: [
                  { id: 1, name: "Cheese Powder", stock: 3, threshold: 1, unit: "kg", source: "MANUAL", status: "ok" },
                ],
              },
            ],
          },
        });
      }
      if (url === "/products") {
        return Promise.resolve({ data: { data: [] } });
      }
      return Promise.resolve({ data: null });
    });
    renderPage();
    await screen.findByText("Cheese Powder");
    const stockCallsBefore = api.get.mock.calls.filter((c) => c[0] === "/inventory").length;
    const productCallsBefore = api.get.mock.calls.filter((c) => c[0] === "/products").length;

    // A stock edit somewhere else (the POS, another tab).
    act(() => {
      __emitLiveEvent(LIVE_EVENTS.inventoryUpdated, { name: "Cheese Powder", action: "adjusted" });
    });

    await vi.waitFor(
      () => {
        const stockCallsAfter = api.get.mock.calls.filter((c) => c[0] === "/inventory").length;
        const productCallsAfter = api.get.mock.calls.filter((c) => c[0] === "/products").length;
        expect(stockCallsAfter).toBeGreaterThan(stockCallsBefore);
        expect(productCallsAfter).toBeGreaterThan(productCallsBefore);
      },
      { timeout: 3000 }
    );
  });

  it("counts a flavor parent's base rows and skips archived products", async () => {
    api.get.mockImplementation((url) => {
      if (url === "/inventory") {
        return Promise.resolve({
          data: {
            locations: [
              {
                code: "CART-01",
                name: "Cart 1",
                items: [
                  { id: 1, name: "Fries (frozen packs)", stock: 3, threshold: 1, unit: "packs", source: "MANUAL", status: "ok" },
                  { id: 2, name: "Old Powder", stock: 3, threshold: 1, unit: "kg", source: "MANUAL", status: "ok" },
                ],
              },
            ],
          },
        });
      }
      if (url === "/products") {
        return Promise.resolve({
          data: {
            data: [
              {
                id: 8,
                name: "BBQ Fries",
                active: true,
                // Base rows every size deducts live on the product itself.
                recipes: [{ itemName: "Fries (frozen packs)", amountPerUnit: 0.05 }],
                flavors: [
                  { id: 13, name: "Medium", recipes: [{ itemName: "Pouch Medium", amountPerUnit: 1 }] },
                ],
              },
              {
                id: 24,
                name: "BBQ Fries - Medium",
                active: false,
                recipes: [{ itemName: "Old Powder", amountPerUnit: 1 }],
                flavors: [],
              },
            ],
          },
        });
      }
      return Promise.resolve({ data: null });
    });
    renderPage();
    expect(await screen.findByText(/Used by BBQ Fries/)).toBeInTheDocument();
    // The archived flat product must not claim the powder any more.
    expect(screen.queryByText(/Used by BBQ Fries - Medium/)).toBeNull();
  });
});
