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

describe("ProductsPage edit change feedback", () => {
  const seedProducts = [
    {
      id: 5,
      name: "Flavored Fries",
      category: "Fries",
      basePrice: 40,
      flavorPrices: {},
      flavors: [
        { id: 1, name: "Cheese", unitPrice: 40, hasCustomPrice: false, recipeCount: 1 },
      ],
      recipeCount: 1,
      orderLines: 0,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockImplementation((url) => {
      if (url === "/products") return Promise.resolve({ data: { data: seedProducts } });
      if (url === "/flavors") return Promise.resolve({ data: { data: seedFlavors } });
      return Promise.resolve({ data: null });
    });
    api.patch.mockResolvedValue({ data: { product: {}, recipesChanged: 0 } });
  });

  async function openEdit() {
    renderPage();
    await screen.findByText("Flavored Fries");
    fireEvent.click(screen.getByTitle("Edit price, flavors, recipes"));
    expect(await screen.findByText("Edit Flavored Fries")).toBeInTheDocument();
  }

  it("reports no changes when nothing was touched", async () => {
    await openEdit();
    fireEvent.click(screen.getByText("Save Changes"));
    expect(await screen.findByText(/No changes — nothing to update/)).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it("names the price move in the success message", async () => {
    await openEdit();
    const modal = screen.getByText("Edit Flavored Fries").closest(".modal");
    // Saved rows start collapsed — expand first.
    fireEvent.click(within(modal).getByLabelText("Expand Cheese"));
    fireEvent.change(within(modal).getByTitle("Leave blank to use the main selling price"), {
      target: { value: "45" },
    });
    fireEvent.click(within(modal).getByText("Save Changes"));

    await screen.findByText(/Cheese P40 ➔ P45/);
    const [url, body] = api.patch.mock.calls[0];
    expect(url).toBe("/products/5");
    expect(body.flavorPrices).toEqual({ Cheese: 45 });
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
    expect(await screen.findByText(/price & recipes per option/)).toBeInTheDocument();
  }

  function addModal() {
    return screen.getByText("Add Product").closest(".modal");
  }

  // The pricing grid has three inputs that all carry placeholder="0.00"
  // ("Base Price (Cost)", "Markup (Tubo)", "Selling Price"), so a bare
  // getByPlaceholderText throws on multiple matches. Scope by field label.
  function moneyInput(labelText) {
    return within(addModal())
      .getByText(labelText)
      .closest("label")
      .querySelector('input[placeholder="0.00"]');
  }

  function fillNameAndPrice(name = "Wasabi Fries", price = "60") {
    fireEvent.change(screen.getByPlaceholderText("e.g. Nachos"), { target: { value: name } });
    fireEvent.change(moneyInput("Selling Price"), { target: { value: price } });
  }

  it("blocks submit when a flavor row has no picked flavor", async () => {
    await openAddModal();
    fillNameAndPrice();
    fireEvent.click(screen.getByText("+ Add size / flavor"));
    fireEvent.click(screen.getByText("Create Product"));
    // Same message at modal level and inline under the bad row.
    const matches = await screen.findAllByText(/Pick a flavor for this row/);
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(api.post).not.toHaveBeenCalled();
  });

  it("shows the row error inline under the bad row and expands it", async () => {
    await openAddModal();
    fillNameAndPrice();
    fireEvent.click(screen.getByText("+ Add size / flavor"));
    const modal = screen.getByText("Add Product").closest(".modal");
    // Collapse the empty row: submit must expand it again with the error.
    fireEvent.click(within(modal).getByLabelText("Collapse flavor row"));
    expect(within(modal).queryByTitle("Leave blank to use the main selling price")).toBeNull();
    fireEvent.click(within(modal).getByText("Create Product"));
    const alerts = await within(modal).findAllByRole("alert");
    expect(alerts.length).toBeGreaterThanOrEqual(2);
    expect(within(modal).getByTitle("Leave blank to use the main selling price")).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("offers known stock items in the recipe picker", async () => {
    api.get.mockImplementation((url) => {
      if (url === "/products") return Promise.resolve({ data: { data: [] } });
      if (url === "/flavors") return Promise.resolve({ data: { data: seedFlavors } });
      if (url === "/inventory/names") {
        return Promise.resolve({ data: { data: [{ name: "Cheese Powder", unit: "kg" }] } });
      }
      return Promise.resolve({ data: null });
    });
    await openAddModal();
    fireEvent.click(screen.getByText("+ Add size / flavor"));
    const modal = screen.getByText("Add Product").closest(".modal");
    const option = modal.querySelector('datalist#cartiq-inventory-items option[value="Cheese Powder"]');
    expect(option).not.toBeNull();
  });

  it("hints when a recipe item matches no stock row", async () => {
    api.get.mockImplementation((url) => {
      if (url === "/products") return Promise.resolve({ data: { data: [] } });
      if (url === "/flavors") return Promise.resolve({ data: { data: seedFlavors } });
      if (url === "/inventory/names") {
        return Promise.resolve({ data: { data: [{ name: "Cheese Powder", unit: "kg" }] } });
      }
      return Promise.resolve({ data: null });
    });
    await openAddModal();
    fillNameAndPrice();
    fireEvent.click(screen.getByText("+ Add size / flavor"));
    const modal = screen.getByText("Add Product").closest(".modal");
    fireEvent.click(within(modal).getByText("+ Recipe line"));
    fireEvent.change(within(modal).getByPlaceholderText("Ingredient item (e.g. Cheese Powder)"), {
      target: { value: "Mystery Dust" },
    });
    expect(await within(modal).findByText(/No stock item named/)).toBeInTheDocument();
  });

  it("converts grams to the kg stock unit on submit", async () => {
    api.post.mockImplementation((url, body) => {
      if (url === "/flavors") {
        return Promise.resolve({ data: { flavor: { id: 9, name: body.name } } });
      }
      if (url === "/products") {
        return Promise.resolve({ data: { product: { id: 7, name: body.name }, recipesCreated: 1 } });
      }
      return Promise.resolve({ data: {} });
    });
    api.get.mockImplementation((url) => {
      if (url === "/products") return Promise.resolve({ data: { data: [] } });
      if (url === "/flavors") return Promise.resolve({ data: { data: seedFlavors } });
      if (url === "/inventory/names") {
        return Promise.resolve({ data: { data: [{ name: "Cheese Powder", unit: "kg" }] } });
      }
      return Promise.resolve({ data: null });
    });
    await openAddModal();
    fillNameAndPrice();
    fireEvent.click(screen.getByText("+ Add size / flavor"));
    fireEvent.change(screen.getByPlaceholderText("New flavor name"), { target: { value: "Cheesy" } });
    const modal = screen.getByText("Add Product").closest(".modal");
    fireEvent.click(within(modal).getByText("Add", { selector: "button" }));
    await screen.findByText('Flavor "Cheesy" created');

    // Stock unit is kg, picker defaults to g: typing 15 stores 0.015.
    fireEvent.click(within(modal).getByText("+ Recipe line"));
    fireEvent.change(within(modal).getByPlaceholderText("Ingredient item (e.g. Cheese Powder)"), {
      target: { value: "Cheese Powder" },
    });
    fireEvent.change(within(modal).getByPlaceholderText("Qty"), { target: { value: "15" } });
    expect(within(modal).getByLabelText("Unit")).toHaveValue("g");

    fireEvent.click(within(modal).getByText("Create Product"));
    await screen.findByText(/created with 1 flavor/);
    const call = api.post.mock.calls.find(([url]) => url === "/products");
    expect(call[1].flavors).toEqual([
      { flavorId: 9, recipes: [{ itemName: "Cheese Powder", amountPerUnit: 0.015 }] },
    ]);
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
    fireEvent.click(screen.getByText("+ Add size / flavor"));
    fireEvent.change(screen.getByPlaceholderText("New flavor name"), { target: { value: "Wasabi" } });
    const modal = screen.getByText("Add Product").closest(".modal");
    fireEvent.click(within(modal).getByText("Add", { selector: "button" }));
    await screen.findByText('Flavor "Wasabi" created');

    // One recipe line on that row.
    fireEvent.click(within(modal).getByText("+ Recipe line"));
    fireEvent.change(within(modal).getByPlaceholderText("Ingredient item (e.g. Cheese Powder)"), {
      target: { value: "Wasabi Powder" },
    });
    fireEvent.change(within(modal).getByPlaceholderText("Qty"), { target: { value: "0.04" } });

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

describe("ProductsPage best sellers + sizes", () => {
  const seedProducts = [
    {
      id: 11,
      name: "Cheese Fries",
      category: "Fries",
      basePrice: 20,
      active: true,
      isBestSeller: false,
      imageUrl: null,
      flavorPrices: { Large: 30 },
      flavors: [
        { id: 3, name: "Medium", unitPrice: 20, hasCustomPrice: false, recipeCount: 1, missingItems: [] },
        { id: 4, name: "Large", unitPrice: 30, hasCustomPrice: true, recipeCount: 1, missingItems: [] },
      ],
      recipeCount: 2,
      orderLines: 5,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockImplementation((url) => {
      if (url === "/products") return Promise.resolve({ data: { data: seedProducts } });
      if (url === "/flavors") return Promise.resolve({ data: { data: seedFlavors } });
      return Promise.resolve({ data: { data: [] } });
    });
    api.patch.mockResolvedValue({ data: {} });
  });

  it("star toggle marks a product as best seller", async () => {
    renderPage();
    expect(await screen.findByText("Cheese Fries")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Add to Best Sellers"));

    await vi.waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/products/11", { isBestSeller: true })
    );
  });

  it("labels the option column for sizes, not just flavors", async () => {
    renderPage();
    expect(await screen.findByText("Sizes / Flavors")).toBeInTheDocument();
  });

  it("shows the star filled for a best seller and unfills on click", async () => {
    api.get.mockImplementation((url) => {
      if (url === "/products") {
        return Promise.resolve({
          data: { data: [{ ...seedProducts[0], isBestSeller: true }] },
        });
      }
      if (url === "/flavors") return Promise.resolve({ data: { data: seedFlavors } });
      return Promise.resolve({ data: { data: [] } });
    });
    renderPage();
    const star = await screen.findByTitle("Remove from Best Sellers");
    expect(star).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(star);
    await vi.waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/products/11", { isBestSeller: false })
    );
  });
});
