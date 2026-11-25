import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Outlet } from "react-router-dom";
import { ToastProvider } from "../components/Toast.jsx";

vi.mock("../api.js", () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
  API_BASE: "/api",
}));

import api from "../api.js";
import VoidRequestsPage from "./VoidRequestsPage.jsx";

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <ToastProvider>
        <Routes>
          <Route
            element={<Outlet context={{ user: { name: "Owner", role: "OWNER" } }} />}
          >
            <Route element={<VoidRequestsPage />} path="/" />
          </Route>
        </Routes>
      </ToastProvider>
    </MemoryRouter>
  );
}

describe("VoidRequestsPage header", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockResolvedValue({
      data: { data: [], meta: { total: 0, page: 1, pageSize: 100, totalPages: 1 } },
    });
  });

  it("renders the header without a manual Refresh action", async () => {
    renderPage();
    expect(await screen.findByText("Void requests")).toBeInTheDocument();
    expect(screen.getByText("Operations")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
  });

  it("shows a table skeleton while requests are loading", () => {
    api.get.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByRole("region", { name: "Loading void requests" })).toBeInTheDocument();
  });
});

describe("VoidRequestsPage approve flow", () => {
  const pendingOrder = {
    id: 7,
    status: "PAID",
    total: 120,
    createdAt: "2026-11-17T00:00:00.000Z",
    voidRequest: {
      status: "pending",
      reason: "wrong item punched",
      requestedByName: "Stall Staff 1",
      requestedAt: "2026-11-17T00:00:00.000Z",
      alertId: 55,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockResolvedValue({
      data: { data: [pendingOrder], meta: { total: 1, page: 1, pageSize: 100, totalPages: 1 } },
    });
    api.patch.mockResolvedValue({
      data: { order: { ...pendingOrder, status: "VOID" }, restored: [], warnings: [] },
    });
  });

  it("approve is one tap - no reason field, Void button ready", async () => {
    renderPage();
    expect(await screen.findByText("#7")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    // The confirm dialog opens with the Void button ready - no note field.
    const confirm = await screen.findByRole("button", { name: "Void order" });
    expect(confirm).not.toBeDisabled();
    expect(screen.queryByLabelText(/decline reason|reason for void|confirmation note/i)).toBeNull();

    fireEvent.click(confirm);
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        "/orders/7/void-request",
        { decision: "approve" },
      ),
    );
  });

  it("deny requires a reason before declining - the note gate is live", async () => {
    renderPage();
    expect(await screen.findByText("#7")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));

    const confirm = await screen.findByRole("button", { name: "Deny request" });
    expect(confirm).toBeDisabled();

    fireEvent.click(screen.getByRole("radio", { name: "Duplicate void request" }));
    expect(screen.getByRole("textbox", { name: "Decline message" })).toHaveValue(
      "Duplicate void request. The original request is being reviewed.",
    );
    expect(confirm).not.toBeDisabled();

    fireEvent.click(confirm);
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/orders/7/void-request", {
        decision: "deny",
        note: "Duplicate void request. The original request is being reviewed.",
      }),
    );
  });

  it("allows editing a selected void denial message template", async () => {
    renderPage();
    expect(await screen.findByText("#7")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    fireEvent.click(screen.getByRole("radio", { name: "Order was already fulfilled" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Decline message" }), {
      target: { value: "Order was already fulfilled. Please review the request." },
    });

    fireEvent.click(screen.getByRole("button", { name: "Deny request" }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/orders/7/void-request", {
        decision: "deny",
        note: "Order was already fulfilled. Please review the request.",
      }),
    );
  });

  it("allows a specific decline reason", async () => {
    renderPage();
    expect(await screen.findByText("#7")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));

    fireEvent.click(screen.getByRole("radio", { name: "Other / type a specific reason" }));
    const confirm = await screen.findByRole("button", { name: "Deny request" });
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByRole("textbox", { name: "Specific reason" }), {
      target: { value: "requested in error" },
    });
    expect(confirm).not.toBeDisabled();

    fireEvent.click(confirm);
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/orders/7/void-request", { decision: "deny", note: "requested in error" }),
    );
  });

  it("bulk voids selected rows from the toolbar below the table", async () => {
    renderPage();
    expect(await screen.findByText("#7")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Select void request for order 7" }));
    expect(screen.getByText("1 of 1 selected")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Void selected" })[0]);
    fireEvent.click((await screen.findAllByRole("button", { name: "Void selected" })).at(-1));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        "/orders/7/void-request",
        { decision: "approve" },
      ),
    );
  });
});
