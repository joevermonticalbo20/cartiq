// Add Cart: name and address validation, before the request is sent.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Outlet } from "react-router-dom";
import { ToastProvider } from "../components/Toast.jsx";

vi.mock("../api.js", () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() },
  API_BASE: "/api",
}));

import api from "../api.js";
import SettingsPage from "./SettingsPage.jsx";
import { __resetLiveData } from "../state/liveData.js";

const emptyOk = (url) => {
  if (url === "/devices" || url === "/auth/staff") {
    return Promise.resolve({ data: { data: [] } });
  }
  if (url === "/locations") return Promise.resolve({ data: { data: [] } });
  return Promise.resolve({ data: {} });
};

describe("SettingsPage Add Cart validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetLiveData();
    api.get.mockImplementation((url) => {
      if (url === "/auth/me") {
        return Promise.resolve({
          data: { user: { name: "Owner", role: "OWNER" } },
        });
      }
      return emptyOk(url);
    });
    api.post.mockResolvedValue({
      data: { device: { deviceId: "esp32-cart-04", active: true }, deviceToken: "tok" },
    });
  });

  async function openModal() {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <ToastProvider>
          <Routes>
            <Route element={<Outlet context={{ user: { role: "OWNER" } }} />}>
              <Route element={<SettingsPage />} path="/" />
            </Route>
          </Routes>
        </ToastProvider>
      </MemoryRouter>
    );
    await screen.findByText("Owner");
    fireEvent.click(screen.getByRole("button", { name: /Add cart/i }));
    const dialog = document.body.querySelector(".modal");
    expect(dialog?.textContent).toContain("Add Cart");
    return dialog;
  }

  it("shows an inline error for a numbers-only cart name and refuses to send", async () => {
    const dialog = await openModal();
    fireEvent.change(within(dialog).getByLabelText(/Cart Code/), { target: { value: "CART-04" } });
    fireEvent.change(within(dialog).getByLabelText(/Cart Name/), {
      target: { value: "123456" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /Create Cart/ }));
    expect(await within(dialog).findByText("Please enter a valid Cart Name.")).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/Cart Name/)).toHaveAttribute("aria-invalid", "true");
    expect(api.post).not.toHaveBeenCalledWith("/locations", expect.anything());
  });

  it("shows an inline error for a punctuation-only cart name", async () => {
    const dialog = await openModal();
    fireEvent.change(within(dialog).getByLabelText(/Cart Code/), { target: { value: "CART-04" } });
    fireEvent.change(within(dialog).getByLabelText(/Cart Name/), {
      target: { value: "@@@@@" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /Create Cart/ }));
    expect(await within(dialog).findByText("Please enter a valid Cart Name.")).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("accepts letters, numbers, spaces, hyphens, apostrophes and ampersands", async () => {
    const dialog = await openModal();
    fireEvent.change(within(dialog).getByLabelText(/Cart Code/), { target: { value: "CART-04" } });
    fireEvent.change(within(dialog).getByLabelText(/Cart Name/), {
      target: { value: "Jones & Sons-02" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /Create Cart/ }));
    await vi.waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/locations",
        expect.objectContaining({ code: "CART-04", name: "Jones & Sons-02" }),
      ),
    );
  });

  it("refuses an invalid address and shows the error below the field", async () => {
    const dialog = await openModal();
    fireEvent.change(within(dialog).getByLabelText(/Cart Code/), { target: { value: "CART-04" } });
    fireEvent.change(within(dialog).getByLabelText(/Cart Name/), {
      target: { value: "Main Cart" },
    });
    fireEvent.change(within(dialog).getByLabelText(/Address/), {
      target: { value: "@@@@@@" },
    });

    fireEvent.click(within(dialog).getByRole("button", { name: /Create Cart/ }));
    expect(await within(dialog).findByText("Please enter a valid address.")).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("renders an inline error when the server refuses the save", async () => {
    api.post.mockImplementation((url) => {
      if (url === "/locations") {
        return Promise.reject(new Error("down"));
      }
      return emptyOk(url);
    });
    const dialog = await openModal();
    fireEvent.change(within(dialog).getByLabelText(/Cart Code/), { target: { value: "CART-04" } });
    fireEvent.change(within(dialog).getByLabelText(/Cart Name/), {
      target: { value: "Main Cart" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /Create Cart/ }));
    // The input keeps the user's text - nothing is lost on failure.
    expect(within(dialog).getByLabelText(/Cart Name/)).toHaveValue("Main Cart");
    expect(await within(dialog).findByText("down")).toBeInTheDocument();
  });

  it("clears the inline error as soon as the user fixes the name", async () => {
    const dialog = await openModal();
    fireEvent.change(within(dialog).getByLabelText(/Cart Code/), { target: { value: "CART-04" } });
    const nameInput = within(dialog).getByLabelText(/Cart Name/);
    fireEvent.change(nameInput, { target: { value: "123" } });

    fireEvent.click(within(dialog).getByRole("button", { name: /Create Cart/ }));
    expect(await within(dialog).findByText("Please enter a valid Cart Name.")).toBeInTheDocument();
    fireEvent.change(nameInput, { target: { value: "Cart 01" } });
    expect(within(dialog).queryByText("Please enter a valid Cart Name.")).toBeNull();
  });
});
