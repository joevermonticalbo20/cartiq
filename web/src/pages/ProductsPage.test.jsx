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

const emptyGet = (url) => {
  if (url === "/products") return Promise.resolve({ data: { data: [] } });
  return Promise.resolve({ data: null });
};

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
    api.get.mockImplementation(emptyGet);
    renderPage();
    expect(await screen.findByText("No products yet")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows an error with retry on failure, not the empty state", async () => {
    api.get.mockImplementation((url) => {
      if (url === "/products") return Promise.reject(new Error("explode"));
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

describe("ProductsPage archived products", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockImplementation((url) => {
      if (url === "/products") {
        return Promise.resolve({
          data: {
            data: [{
              id: 24,
              name: "Seasonal Fries",
              category: "Fries",
              basePrice: 20,
              sellingPrice: 45,
              active: false,
              imageUrl: null,
              recipeCount: 0,
              missingItems: [],
            }],
          },
        });
      }
      return Promise.resolve({ data: null });
    });
  });

  it("highlights archived rows without a badge and only shows unarchive and delete", async () => {
    renderPage();
    const row = (await screen.findByText("Seasonal Fries")).closest("tr");

    expect(row).toHaveClass("product-row-archived");
    expect(within(row).queryByText("Archived")).toBeNull();
    expect(within(row).getByTitle("Unarchive product")).toBeInTheDocument();
    expect(within(row).getByTitle("Delete product")).toBeInTheDocument();
    expect(within(row).queryByTitle("Edit price and recipe")).toBeNull();
    expect(within(row).queryByTitle("Rename product")).toBeNull();
    expect(within(row).queryByTitle("Archive product (hide from POS)")).toBeNull();
  });
});

describe("ProductsPage edit change feedback", () => {
  const seedProducts = [
    {
      id: 5,
      name: "Cheese Fries - Medium",
      category: "Fries",
      basePrice: 20,
      active: true,
      imageUrl: null,
      recipes: [
        { itemName: "Pouch Medium", amountPerUnit: 1 },
        { itemName: "Fries (frozen packs)", amountPerUnit: 0.05 },
      ],
      recipeCount: 2,
      missingItems: [],
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockImplementation((url) => {
      if (url === "/products") return Promise.resolve({ data: { data: seedProducts } });
      return Promise.resolve({ data: null });
    });
    api.patch.mockResolvedValue({ data: { product: {}, recipesChanged: 0 } });
  });

  async function openEdit() {
    renderPage();
    await screen.findByText("Cheese Fries - Medium");
    fireEvent.click(screen.getByTitle("Edit price and recipe"));
    expect(await screen.findByText("Edit Cheese Fries - Medium")).toBeInTheDocument();
  }

  it("reports no changes when nothing was touched", async () => {
    await openEdit();
    fireEvent.click(screen.getByText("Save Changes"));
    expect(await screen.findByText(/No changes — nothing to update/)).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it("saves edited recipe line amounts with flavor \"\" (flat product)", async () => {
    await openEdit();
    const modal = screen.getByText("Edit Cheese Fries - Medium").closest(".modal");
    const qtyInputs = within(modal).getAllByPlaceholderText("Qty");
    expect(qtyInputs).toHaveLength(2);
    expect(qtyInputs[0]).toHaveValue(1);
    expect(within(modal).getAllByPlaceholderText("Ingredient item (e.g. Cheese Powder)")[0]).toHaveValue("Pouch Medium");

    fireEvent.change(qtyInputs[0], { target: { value: "2" } });
    fireEvent.click(screen.getByText("Save Changes"));

    await vi.waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        "/products/5",
        expect.objectContaining({
          addRecipes: expect.arrayContaining([{ flavor: "", itemName: "Pouch Medium", amountPerUnit: 2 }]),
        })
      )
    );
  });

  it("removes a baseline recipe line via removeRecipes", async () => {
    await openEdit();
    const modal = screen.getByText("Edit Cheese Fries - Medium").closest(".modal");
    const removeButtons = within(modal).getAllByTitle("Remove recipe line");
    fireEvent.click(removeButtons[0]);
    fireEvent.click(screen.getByText("Save Changes"));

    await vi.waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        "/products/5",
        expect.objectContaining({
          removeRecipes: [{ flavor: "", itemName: "Pouch Medium" }],
        })
      )
    );
  });
});

describe("ProductsPage flat product add", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockImplementation(emptyGet);
  });

  async function openAddModal() {
    renderPage();
    await screen.findByText("No products yet");
    fireEvent.click(screen.getByText("Add product"));
    expect(await screen.findByText(/ingredients deducted per unit/i)).toBeInTheDocument();
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

  it("offers known stock items in the recipe picker", async () => {
    api.get.mockImplementation((url) => {
      if (url === "/products") return Promise.resolve({ data: { data: [] } });
      if (url === "/inventory/names") {
        return Promise.resolve({ data: { data: [{ name: "Cheese Powder", unit: "kg" }] } });
      }
      return Promise.resolve({ data: null });
    });
    await openAddModal();
    fireEvent.click(screen.getByText("+ Recipe line"));
    const modal = screen.getByText("Add Product").closest(".modal");
    const option = modal.querySelector('datalist#cartiq-inventory-items option[value="Cheese Powder"]');
    expect(option).not.toBeNull();
  });

  it("hints when a recipe item matches no stock row", async () => {
    api.get.mockImplementation((url) => {
      if (url === "/products") return Promise.resolve({ data: { data: [] } });
      if (url === "/inventory/names") {
        return Promise.resolve({ data: { data: [{ name: "Cheese Powder", unit: "kg" }] } });
      }
      return Promise.resolve({ data: null });
    });
    await openAddModal();
    fillNameAndPrice();
    fireEvent.click(screen.getByText("+ Recipe line"));
    const modal = screen.getByText("Add Product").closest(".modal");
    fireEvent.change(within(modal).getByPlaceholderText("Ingredient item (e.g. Cheese Powder)"), {
      target: { value: "Mystery Dust" },
    });
    expect(await within(modal).findByText(/No stock item named/)).toBeInTheDocument();
  });

  it("converts grams to the kg stock unit and saves via addRecipes", async () => {
    api.post.mockResolvedValue({ data: { product: { id: 7, name: "Wasabi Fries" } } });
    api.patch.mockResolvedValue({ data: { product: {}, recipesChanged: 1 } });
    api.get.mockImplementation((url) => {
      if (url === "/products") return Promise.resolve({ data: { data: [] } });
      if (url === "/inventory/names") {
        return Promise.resolve({ data: { data: [{ name: "Cheese Powder", unit: "kg" }] } });
      }
      return Promise.resolve({ data: null });
    });
    await openAddModal();
    fillNameAndPrice();
    const modal = screen.getByText("Add Product").closest(".modal");

    fireEvent.click(screen.getByText("+ Recipe line"));
    fireEvent.change(within(modal).getByPlaceholderText("Ingredient item (e.g. Cheese Powder)"), {
      target: { value: "Cheese Powder" },
    });
    fireEvent.change(within(modal).getByPlaceholderText("Qty"), { target: { value: "15" } });
    expect(within(modal).getByLabelText("Unit")).toHaveTextContent("g");

    fireEvent.click(within(modal).getByText("Create Product"));
    await screen.findByText(/wasabi|created/i);
    const [url, body] = api.patch.mock.calls[0];
    expect(url).toBe("/products/7");
    expect(body.addRecipes).toEqual([{ flavor: "", itemName: "Cheese Powder", amountPerUnit: 0.015 }]);
  });

  it("creates the product without recipes when the list is empty", async () => {
    api.post.mockResolvedValue({ data: { product: { id: 8, name: "Cheese Dip" } } });
    await openAddModal();
    fillNameAndPrice("Cheese Dip", "15");
    fireEvent.click(screen.getByText("Create Product"));
    await screen.findByText(/created/);
    expect(api.post).toHaveBeenCalledWith(
      "/products",
      expect.objectContaining({ name: "Cheese Dip", basePrice: 15 })
    );
    expect(api.patch).not.toHaveBeenCalled();
  });

  it("creates multiple flavors with separate recipe panels and shared product pricing", async () => {
    api.post.mockResolvedValue({ data: { product: { id: 9, name: "Fries" } } });
    api.get.mockImplementation((url) => {
      if (url === "/products") return Promise.resolve({ data: { data: [] } });
      if (url === "/inventory/names") {
        return Promise.resolve({ data: { data: [{ name: "Cheese Powder", unit: "kg" }] } });
      }
      return Promise.resolve({ data: null });
    });
    await openAddModal();
    fillNameAndPrice("Fries", "50");
    fireEvent.click(screen.getByText("Add flavor/variant"));
    const modal = addModal();
    const flavorPanel = within(modal).getByPlaceholderText("e.g. Cheese").closest("div").parentElement;
    expect(within(flavorPanel).queryByText("Selling price")).toBeNull();
    fireEvent.change(within(modal).getAllByPlaceholderText("e.g. Cheese")[0], {
      target: { value: "Cheese" },
    });
    fireEvent.click(within(modal).getByText("Edit recipe"));
    expect(within(modal).getByRole("region", { name: "Cheese recipe" })).toBeInTheDocument();
    fireEvent.click(within(modal).getAllByText("+ Recipe line")[0]);
    fireEvent.change(within(modal).getByPlaceholderText("Ingredient item (e.g. Cheese Powder)"), {
      target: { value: "Cheese Powder" },
    });
    fireEvent.change(within(modal).getByPlaceholderText("Qty"), { target: { value: "12" } });
    fireEvent.click(within(modal).getByText("Add flavor/variant"));
    fireEvent.change(within(modal).getAllByPlaceholderText("e.g. Cheese")[1], {
      target: { value: "BBQ" },
    });
    fireEvent.click(within(modal).getByText("Create Product"));

    await screen.findByText(/created/i);
    expect(api.post).toHaveBeenCalledWith("/products", expect.objectContaining({
      name: "Fries",
      basePrice: 50,
      flavors: [
        {
          name: "Cheese",
          recipes: [{ itemName: "Cheese Powder", amountPerUnit: 0.012 }],
        },
        { name: "BBQ", recipes: [] },
      ],
    }));
    expect(api.patch).not.toHaveBeenCalled();
  });
});

describe("ProductsPage best sellers + flat catalog", () => {
  const seedProducts = [
    {
      id: 11,
      name: "Cheese Fries - Medium",
      category: "Fries",
      basePrice: 20,
      active: true,
      isBestSeller: false,
      imageUrl: null,
      recipes: [{ itemName: "Pouch Medium", amountPerUnit: 1 }],
      recipeCount: 1,
      missingItems: [],
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockImplementation((url) => {
      if (url === "/products") return Promise.resolve({ data: { data: seedProducts } });
      return Promise.resolve({ data: [] });
    });
    api.patch.mockResolvedValue({ data: {} });
  });

  it("star toggle marks a product as best seller", async () => {
    renderPage();
    expect(await screen.findByText("Cheese Fries - Medium")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Add to Best Sellers"));

    await vi.waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/products/11", { isBestSeller: true })
    );
  });

  it("shows the flat Recipes column with the recipe count", async () => {
    renderPage();
    await screen.findByText("Cheese Fries - Medium");
    expect(await screen.findByText("Recipes")).toBeInTheDocument();
    expect(await screen.findByTitle("1 recipe row(s)")).toHaveTextContent("1");
  });

  it("lists the most recently added product first", async () => {
    api.get.mockImplementation((url) => {
      if (url === "/products") {
        return Promise.resolve({
          data: {
            data: [
              { ...seedProducts[0], id: 11 },
              { ...seedProducts[0], id: 12, name: "New Fries" },
            ],
          },
        });
      }
      return Promise.resolve({ data: { data: [] } });
    });
    renderPage();
    const newest = await screen.findByText("New Fries");
    const rows = newest.closest("tbody").querySelectorAll("tr");
    expect(rows[0]).toHaveTextContent("New Fries");
    expect(rows[1]).toHaveTextContent("Cheese Fries - Medium");
  });

  it("shows variants in the table and lets each flavor recipe be edited", async () => {
    const variant = {
      id: 2,
      name: "Cheese",
      unitPrice: 60,
      recipes: [{ itemName: "Cheese Powder", amountPerUnit: 0.01 }],
      recipeCount: 1,
    };
    api.get.mockImplementation((url) => {
      if (url === "/products") {
        return Promise.resolve({
          data: { data: [{ ...seedProducts[0], flavors: [variant] }] },
        });
      }
      return Promise.resolve({ data: { data: [] } });
    });
    renderPage();
    const row = (await screen.findByText("Cheese Fries - Medium")).closest("tr");
    expect(screen.getByRole("columnheader", { name: "Flavor/Variants" })).toBeInTheDocument();
    expect(within(row).getByText("Cheese")).toBeInTheDocument();
    fireEvent.click(within(row).getByTitle("Edit price and recipe"));

    const dialog = await screen.findByRole("dialog", { name: "Edit Cheese Fries - Medium" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit recipe" }));
    const recipePanel = within(dialog).getByRole("region", { name: "Cheese recipe" });
    fireEvent.change(within(recipePanel).getByPlaceholderText("Qty"), { target: { value: "20" } });
    fireEvent.click(within(dialog).getByText("Save Changes"));

    await vi.waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        "/products/11",
        expect.objectContaining({
          flavors: [
            { name: "Cheese", recipes: [{ itemName: "Cheese Powder", amountPerUnit: 20 }] },
          ],
          addRecipes: [{ flavor: "Cheese", itemName: "Cheese Powder", amountPerUnit: 20 }],
        })
      )
    );
  });

  it("adds a new flavor through the edit dialog and sends the full list", async () => {
    api.get.mockImplementation((url) => {
      if (url === "/products") {
        return Promise.resolve({
          data: { data: [{ ...seedProducts[0], flavors: [] }] },
        });
      }
      return Promise.resolve({ data: { data: [] } });
    });
    renderPage();
    const row = (await screen.findByText("Cheese Fries - Medium")).closest("tr");
    fireEvent.click(within(row).getByTitle("Edit price and recipe"));

    const dialog = await screen.findByRole("dialog", { name: "Edit Cheese Fries - Medium" });
    fireEvent.click(within(dialog).getByText("Add flavor/variant"));
    fireEvent.change(within(dialog).getByPlaceholderText("e.g. Cheese"), {
      target: { value: "BBQ" },
    });
    fireEvent.click(within(dialog).getByText("Save Changes"));

    await vi.waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        "/products/11",
        expect.objectContaining({
          flavors: [{ name: "BBQ", recipes: [] }],
        })
      )
    );
  });

  it("shows the star filled for a best seller and unfills on click", async () => {
    api.get.mockImplementation((url) => {
      if (url === "/products") {
        return Promise.resolve({
          data: { data: [{ ...seedProducts[0], isBestSeller: true }] },
        });
      }
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
