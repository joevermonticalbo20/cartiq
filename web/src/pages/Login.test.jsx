import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../api.js", () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() },
  writeSession: vi.fn(),
}));

vi.mock("../utils/errors.js", () => ({
  getFriendlyError: (err, fallback) => err?.message || fallback,
}));

import api, { writeSession } from "../api.js";
import Login from "./Login.jsx";

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <Login />
    </MemoryRouter>
  );
}

function fillLogin(username = "owner", password = "owner123") {
  fireEvent.change(screen.getByLabelText("Username"), {
    target: { value: username },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: password },
  });
}

describe("Login remember-me row", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.post.mockResolvedValue({
      data: { token: "t", refreshToken: "r", user: { username: "owner" } },
    });
  });

  it("shows a checked Remember me box and a forgot-password button", () => {
    renderPage();
    const box = screen.getByLabelText("Remember me");
    expect(box.checked).toBe(true);
    expect(
      screen.getByRole("button", { name: "Forgot password?" })
    ).toBeInTheDocument();
  });

  it("persists the session when remembered (default)", async () => {
    renderPage();
    fillLogin();
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await vi.waitFor(() => {
      expect(writeSession).toHaveBeenCalledWith({
        token: "t",
        refreshToken: "r",
        remember: true,
      });
    });
  });

  it("scopes the session to the tab when unchecked", async () => {
    renderPage();
    fillLogin();
    fireEvent.click(screen.getByLabelText("Remember me"));
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await vi.waitFor(() => {
      expect(writeSession).toHaveBeenCalledWith({
        token: "t",
        refreshToken: "r",
        remember: false,
      });
    });
  });

  it("swaps the form side to recovery inline (no navigation)", async () => {
    renderPage();
    expect(screen.getByText("Welcome back")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
    expect(await screen.findByText("Forgot Password?")).toBeInTheDocument();
    expect(screen.getByText("STEP 1 OF 3")).toBeInTheDocument();
    // Login form is gone, brand side stays.
    expect(screen.queryByText("Welcome back")).toBeNull();
    expect(screen.getByText("Command Center")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to Login" }));
    expect(await screen.findByText("Welcome back")).toBeInTheDocument();
    expect(screen.queryByText("Forgot Password?")).toBeNull();
  });
});
