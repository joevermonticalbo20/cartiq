import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Outlet } from "react-router-dom";
import { ToastProvider } from "../components/Toast.jsx";

vi.mock("../api.js", () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() },
  API_BASE: "/api",
}));

import api from "../api.js";
import ProductsPage from "./ProductsPage.jsx";

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <ToastProvider>
        <Routes>
          <Route
            element={<Outlet context={{ user: { name: "Owner", role: "OWNER" } }} />}
          >
            <Route element={<ProductsPage />} path="/" />
          </Route>
        </Routes>
      </ToastProvider>
    </MemoryRouter>
  );
}

const seedFlavors = [
  { id: 1, name: "Cheese" },
  { id: 2, name: "BBQ" },
];

describe("ProductsPage loading/error states", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows a loading skeleton with status text while fetching", () => {
    api.get.mockReturnValue(new Promise(() => {}));
    const { container } = renderPage();
    expect(container.querySelector(".skel")).not.toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Loading products");
    expect(screen.queryByText("No products yet")).toBeNull();
  });

  it("shows the empty state on success with zero products", async () => {
    api.get.mockImplementation((url) => {
      if (url === "/products") return Promise.resolve({ data: { data: [] } });
      if (url === "/flavors") return Promise.resolve({ data: { data: seedFlavors } });
      return Promise.resolve({ data: null });
    });
    renderPage();
    expect(await screen.findByText("No products yet")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows an error with retry on failure, not the empty state", async () => {
    api.get.mockImplementation((url) => {
      if (url === "/products") return Promise.reject(new Error("explode"));
      if (url === "/flavors") return Promise.resolve({ data: { data: seedFlavors } });
      return Promise.resolve({ data: null });
    });
    renderPage();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("explode");
    expect(within(alert).getByText("Retry")).toBeInTheDocument();
    expect(screen.queryByText("No products yet")).toBeNull();
  });

  it("retry re-fetches after a failure", async () => {
    let calls = 0;
    api.get.mockImplementation((url) => {
      if (url === "/products") {
        calls++;
        if (calls === 1) return Promise.reject(new Error("down"));
        return Promise.resolve({ data: { data: [] } });
      }
      if (url === "/flavors") return Promise.resolve({ data: { data: seedFlavors } });
      return Promise.resolve({ data: null });
    });
    renderPage();
    const alert = await screen.findByRole("alert");
    const callsBeforeRetry = api.get.mock.calls.length;
    fireEvent.click(within(alert).getByText("Retry"));
    expect(await screen.findByText("No products yet")).toBeInTheDocument();
    expect(api.get.mock.calls.length).toBeGreaterThan(callsBeforeRetry);
  });
});

describe("ProductsPage by-flavor add", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockImplementation((url) => {
      if (url === "/products") return Promise.resolve({ data: { data: [] } });
      if (url === "/flavors") return Promise.resolve({ data: { data: seedFlavors } });
      return Promise.resolve({ data: null });
    });
  });

  async function openAddModal() {
    renderPage();
    await screen.findByText("No products yet");
    fireEvent.click(screen.getByText("Add product"));
    expect(await screen.findByText(/price & recipes per flavor/)).toBeInTheDocument();
  }

  function fillNameAndPrice(name = "Wasabi Fries", price = "60") {
    fireEvent.change(screen.getByPlaceholderText("e.g. Nachos"), { target: { value: name } });
    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: price } });
  }

  it("blocks submit when a flavor row has no picked flavor", async () => {
    await openAddModal();
    fillNameAndPrice();
    fireEvent.click(screen.getByText("+ Add flavor"));
    fireEvent.click(screen.getByText("Create Product"));
    expect(await screen.findByText(/Pick a flavor for every flavor row/)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("creates the product with per-flavor rows (inline flavor + recipe line)", async () => {
    api.post.mockImplementation((url, body) => {
      if (url === "/flavors") {
        return Promise.resolve({ data: { flavor: { id: 9, name: body.name } } });
      }
      if (url === "/products") {
        return Promise.resolve({ data: { product: { id: 7, name: body.name }, recipesCreated: 1 } });
      }
      return Promise.resolve({ data: {} });
    });
    await openAddModal();
    fillNameAndPrice();

    // New flavor row, then inline-create the flavor into it.
    fireEvent.click(screen.getByText("+ Add flavor"));
    fireEvent.change(screen.getByPlaceholderText("New flavor name"), { target: { value: "Wasabi" } });
    const modal = screen.getByText("Add Product").closest(".modal");
    fireEvent.click(within(modal).getByText("Add", { selector: "button" }));
    await screen.findByText('Flavor "Wasabi" created');

    // One recipe line on that row.
    fireEvent.click(within(modal).getByText("+ Recipe line"));
    fireEvent.change(within(modal).getByPlaceholderText("Ingredient item (e.g. Cheese Powder)"), {
      target: { value: "Wasabi Powder" },
    });
    fireEvent.change(within(modal).getByPlaceholderText("Qty / unit"), { target: { value: "0.04" } });

    fireEvent.click(within(modal).getByText("Create Product"));
    await screen.findByText(/created with 1 flavor/);

    const call = api.post.mock.calls.find(([url]) => url === "/products");
    expect(call).toBeDefined();
    expect(call[1].flavors).toEqual([
      {
        flavorId: 9,
        recipes: [{ itemName: "Wasabi Powder", amountPerUnit: 0.04 }],
      },
    ]);
  });
});
