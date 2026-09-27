import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

vi.mock("../api.js", () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() },
}));

vi.mock("../utils/errors.js", () => ({
  getFriendlyError: (err, fallback) => err?.message || fallback,
}));

import api from "../api.js";
import ForgotPassword from "./ForgotPassword.jsx";

function renderRoute() {
  return render(
    <MemoryRouter initialEntries={["/forgot-password"]}>
      <Routes>
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/login" element={<div>Login screen</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("ForgotPassword route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.post.mockResolvedValue({ data: {} });
  });

  it("renders the shared recovery flow at step 1", async () => {
    renderRoute();
    expect(await screen.findByText("STEP 1 OF 3")).toBeInTheDocument();
    expect(screen.getByText("Forgot Password?")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Send Reset Code" })
    ).toBeInTheDocument();
  });

  it("back button returns to /login", async () => {
    renderRoute();
    await screen.findByText("STEP 1 OF 3");
    fireEvent.click(screen.getByRole("button", { name: "Back to Login" }));
    expect(await screen.findByText("Login screen")).toBeInTheDocument();
  });
});
