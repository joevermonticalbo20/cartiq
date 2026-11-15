// Staff/admin account rules: the Full name and Username fields.
//
// The owner's rules are enforced in the browser (inline messages under the
// field) and again on the server (api/src/routes/auth.js and the Edge
// mirror). These tests cover the browser half.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Outlet } from "react-router-dom";
import { ToastProvider } from "../components/Toast.jsx";

vi.mock("../api.js", () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  clearSession: vi.fn(),
}));

vi.mock("../utils/errors.js", () => ({
  getFriendlyError: (err, fallback) => err?.message || fallback,
}));

import api from "../api.js";
import { __resetLiveData } from "../state/liveData.js";
import SettingsPage from "./SettingsPage.jsx";

const ownerRow = {
  id: 1, name: "Owner", username: "owner", role: "OWNER", active: true,
  email: "owner@cartiq.local", location: null, rfidUid: null, createdAt: "2026-01-01T00:00:00.000Z",
};
const secondAdmin = {
  id: 3, name: "Co Owner", username: "coowner", role: "OWNER", active: true,
  email: "co@example.com", location: null, rfidUid: null, createdAt: "2026-02-01T00:00:00.000Z",
};
const staffRow = {
  id: 2, name: "Stall Staff 1", username: "staff01", role: "STAFF", active: true,
  email: "staff01@cartiq.local", location: { code: "CART-01", name: "CART-01" }, rfidUid: "1A1336E1",
};

const emptyOk = (url) => {
  if (url === "/catalog") return Promise.resolve({ data: { locations: [] } });
  if (url === "/devices" || url === "/auth/staff") {
    return Promise.resolve({ data: { data: [] } });
  }
  return Promise.resolve({ data: {} });
};

function renderOwnerPage() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <ToastProvider>
        <Routes>
          <Route
            element={<Outlet context={{ user: { id: 1, name: "Owner", username: "owner", role: "OWNER" } }} />}
          >
            <Route element={<SettingsPage />} path="/" />
          </Route>
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

function openModal() {
  return document.body.querySelector(".modal");
}

describe("staff and admin account fields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetLiveData();
    api.get.mockImplementation((url) => {
      if (url === "/auth/me") {
        return Promise.resolve({ data: { user: { id: 1, name: "Owner", username: "owner", role: "OWNER" } } });
      }
      if (url === "/auth/staff") {
        return Promise.resolve({ data: { data: [ownerRow, secondAdmin, staffRow] } });
      }
      return emptyOk(url);
    });
    api.post.mockResolvedValue({
      data: { user: { id: 4, name: "New Staff", username: "newstaff", role: "STAFF", active: true } },
    });
    api.patch.mockResolvedValue({ data: { user: { id: 3 } } });
  });

  it("shows no error before the owner touches the form", async () => {
    renderOwnerPage();
    expect(await screen.findByText("Staff accounts")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Add staff/i }));
    const dialog = openModal();
    expect(dialog.textContent).toContain("Add staff account");
    // Nothing is flagged on open: an empty form is not an error yet.
    expect(within(dialog).queryByText("Full name is required.")).toBeNull();
    expect(within(dialog).queryByText("Username is required.")).toBeNull();
    expect(within(dialog).getByLabelText(/Full name/)).not.toHaveAttribute("aria-invalid");
  });

  it("refuses an empty name and username, with a message under each field", async () => {
    renderOwnerPage();
    expect(await screen.findByText("Staff accounts")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Add staff/i }));
    const dialog = openModal();
    fireEvent.click(within(dialog).getByRole("button", { name: /Create account/ }));
    expect(await within(dialog).findByText("Full name is required.")).toBeInTheDocument();
    expect(within(dialog).getByText("Username is required.")).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/Full name/)).toHaveAttribute("aria-invalid", "true");
    expect(within(dialog).getByLabelText(/^Username/)).toHaveAttribute("aria-invalid", "true");
    expect(api.post).not.toHaveBeenCalled();
  });

  it("refuses a name with numbers or special characters", async () => {
    renderOwnerPage();
    expect(await screen.findByText("Staff accounts")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Add staff/i }));
    const dialog = openModal();
    const nameInput = within(dialog).getByLabelText(/Full name/);
    fireEvent.change(nameInput, { target: { value: "Juan123" } });
    fireEvent.change(within(dialog).getByLabelText(/^Username/), { target: { value: "juan123" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Create account/ }));
    expect(
      await within(dialog).findByText("Full name cannot contain numbers or special characters.")
    ).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("refuses a username that starts with a digit and one with spaces", async () => {
    renderOwnerPage();
    expect(await screen.findByText("Staff accounts")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Add staff/i }));
    const dialog = openModal();
    fireEvent.change(within(dialog).getByLabelText(/Full name/), { target: { value: "Juan Dela Cruz" } });
    fireEvent.change(within(dialog).getByLabelText(/^Username/), { target: { value: "12345678" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Create account/ }));
    expect(await within(dialog).findByText("Username must start with a letter.")).toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText(/^Username/), { target: { value: "staff 001" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Create account/ }));
    expect(
      await within(dialog).findByText("Username cannot contain spaces or special characters.")
    ).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("clears the message as soon as the field is corrected", async () => {
    renderOwnerPage();
    expect(await screen.findByText("Staff accounts")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Add staff/i }));
    const dialog = openModal();
    const nameInput = within(dialog).getByLabelText(/Full name/);
    fireEvent.change(nameInput, { target: { value: "Juan123" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Create account/ }));
    expect(
      await within(dialog).findByText("Full name cannot contain numbers or special characters.")
    ).toBeInTheDocument();
    fireEvent.change(nameInput, { target: { value: "Juan Dela Cruz" } });
    expect(
      within(dialog).queryByText("Full name cannot contain numbers or special characters.")
    ).toBeNull();
    expect(nameInput).not.toHaveAttribute("aria-invalid");
  });

  it("focuses the first invalid field", async () => {
    renderOwnerPage();
    expect(await screen.findByText("Staff accounts")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Add staff/i }));
    const dialog = openModal();
    fireEvent.click(within(dialog).getByRole("button", { name: /Create account/ }));
    await within(dialog).findByText("Full name is required.");
    expect(within(dialog).getByLabelText(/Full name/)).toHaveFocus();
  });

  it("sends a trimmed name and a lowercased username", async () => {
    renderOwnerPage();
    expect(await screen.findByText("Staff accounts")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Add staff/i }));
    const dialog = openModal();
    fireEvent.change(within(dialog).getByLabelText(/Full name/), {
      target: { value: "  Juan Dela Cruz  " },
    });
    fireEvent.change(within(dialog).getByLabelText(/^Username/), { target: { value: "Juan123" } });
    fireEvent.change(within(dialog).getByLabelText(/^Password/), {
      target: { value: "Str0ngPassw0rd!" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /Create account/ }));
    await vi.waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/auth/staff",
        expect.objectContaining({ name: "Juan Dela Cruz", username: "juan123" }),
      ),
    );
  });

  it("keeps what was typed when the server refuses the account", async () => {
    api.post.mockRejectedValue(new Error("This username is already taken."));
    renderOwnerPage();
    expect(await screen.findByText("Staff accounts")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Add staff/i }));
    const dialog = openModal();
    fireEvent.change(within(dialog).getByLabelText(/Full name/), { target: { value: "Juan Dela Cruz" } });
    fireEvent.change(within(dialog).getByLabelText(/^Username/), { target: { value: "juandelacruz" } });
    fireEvent.change(within(dialog).getByLabelText(/^Password/), {
      target: { value: "Str0ngPassw0rd!" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /Create account/ }));
    expect(await within(dialog).findByText("This username is already taken.")).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/Full name/)).toHaveValue("Juan Dela Cruz");
    expect(within(dialog).getByLabelText(/^Username/)).toHaveValue("juandelacruz");
  });

  it("does not create the account twice when Create is double-clicked", async () => {
    let resolvePost;
    api.post.mockImplementation(() => new Promise((resolve) => { resolvePost = resolve; }));
    renderOwnerPage();
    expect(await screen.findByText("Staff accounts")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Add staff/i }));
    const dialog = openModal();
    fireEvent.change(within(dialog).getByLabelText(/Full name/), { target: { value: "Juan Dela Cruz" } });
    fireEvent.change(within(dialog).getByLabelText(/^Username/), { target: { value: "juandelacruz" } });
    fireEvent.change(within(dialog).getByLabelText(/^Password/), {
      target: { value: "Str0ngPassw0rd!" },
    });
    const createBtn = within(dialog).getByRole("button", { name: /Create account/ });
    fireEvent.click(createBtn);
    fireEvent.click(createBtn);
    expect(api.post).toHaveBeenCalledTimes(1);
    // The button is locked while the request is in flight.
    expect(within(dialog).getByRole("button", { name: /Creating/ })).toBeDisabled();
    resolvePost({ data: { user: { id: 4 } } });
  });

  it("flags a bad value once the owner leaves the field, but stays quiet on an empty one", async () => {
    renderOwnerPage();
    expect(await screen.findByText("Staff accounts")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Add staff/i }));
    const dialog = openModal();
    const nameInput = within(dialog).getByLabelText(/Full name/);
    // An empty field the owner merely tabbed past is not an error yet.
    fireEvent.blur(nameInput);
    expect(within(dialog).queryByText("Full name is required.")).toBeNull();

    fireEvent.change(nameInput, { target: { value: "Juan123" } });
    fireEvent.blur(nameInput);
    expect(
      await within(dialog).findByText("Full name cannot contain numbers or special characters.")
    ).toBeInTheDocument();

    const usernameInput = within(dialog).getByLabelText(/^Username/);
    fireEvent.change(usernameInput, { target: { value: "staff 001" } });
    fireEvent.blur(usernameInput);
    expect(
      await within(dialog).findByText("Username cannot contain spaces or special characters.")
    ).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("applies the same rules to the Add admin form", async () => {
    renderOwnerPage();
    expect(await screen.findByText("Administrators")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Add admin/i }));
    const dialog = openModal();
    expect(dialog.textContent).toContain("Add admin account");
    fireEvent.click(within(dialog).getByRole("button", { name: /Create account/ }));
    expect(await within(dialog).findByText("Full name is required.")).toBeInTheDocument();
    expect(within(dialog).getByText("Username is required.")).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("refuses a bad name and username when editing an admin", async () => {
    renderOwnerPage();
    expect(await screen.findByText("Co Owner")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Edit admin"));
    const dialog = await screen.findByRole("dialog", { name: "Edit admin account" });
    fireEvent.change(within(dialog).getByLabelText(/Full name/), { target: { value: "Co Owner2" } });
    fireEvent.change(within(dialog).getByLabelText(/^Username/), { target: { value: "coowner" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Save Changes/ }));
    expect(
      await within(dialog).findByText("Full name cannot contain numbers or special characters.")
    ).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();

    // Fixing the name and giving a username that starts with a digit is still refused.
    fireEvent.change(within(dialog).getByLabelText(/Full name/), { target: { value: "Co Owner" } });
    fireEvent.change(within(dialog).getByLabelText(/^Username/), { target: { value: "9coowner" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Save Changes/ }));
    expect(await within(dialog).findByText("Username must start with a letter.")).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it("saves a corrected admin name and username", async () => {
    renderOwnerPage();
    expect(await screen.findByText("Co Owner")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Edit admin"));
    const dialog = await screen.findByRole("dialog", { name: "Edit admin account" });
    fireEvent.change(within(dialog).getByLabelText(/Full name/), { target: { value: "  Co-Owner  " } });
    fireEvent.change(within(dialog).getByLabelText(/^Username/), { target: { value: "COOWNER2" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Save Changes/ }));
    await vi.waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/auth/staff/3", {
        name: "Co-Owner",
        username: "coowner2",
        email: "co@example.com",
      }),
    );
  });

  it("refuses a bad name when editing a staff account, and keeps the username locked", async () => {
    renderOwnerPage();
    expect(await screen.findByText("Stall Staff 1")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Edit Staff Details"));
    const dialog = openModal();
    expect(dialog.textContent).toContain("Edit Staff Account");
    // The username is immutable - it cannot be edited, so it cannot be invalid.
    expect(within(dialog).getByLabelText(/Username/)).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Full name/), { target: { value: "Stall Staff 1!" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Save Changes/ }));
    expect(
      await within(dialog).findByText("Full name cannot contain numbers or special characters.")
    ).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();
  });
});
