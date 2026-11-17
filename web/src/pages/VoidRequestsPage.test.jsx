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

  it("approve requires a reason before voiding - the note gate is live", async () => {
    renderPage();
    expect(await screen.findByText("#7")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    // The dialog opens with the Void button disabled until the reason is valid.
    const confirm = await screen.findByRole("button", { name: "Void order" });
    expect(confirm).toBeDisabled();

    const noteField = screen.getByLabelText(/reason for void/i);
    fireEvent.change(noteField, { target: { value: "ok" } });

    expect(confirm).not.toBeDisabled();
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        "/orders/7/void-request",
        { decision: "approve", note: "ok" },
      ),
    );
  });

  it("deny requires a reason before declining - the note gate is live", async () => {
    renderPage();
    expect(await screen.findByText("#7")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));

    const confirm = await screen.findByRole("button", { name: "Deny request" });
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/decline reason/i), {
      target: { value: "requested in error" },
    });
    expect(confirm).not.toBeDisabled();

    fireEvent.click(confirm);
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/orders/7/void-request", { decision: "deny", note: "requested in error" }),
    );
  });
});
