import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../api.js", () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() },
}));

vi.mock("../utils/errors.js", () => ({
  getFriendlyError: (err, fallback) => err?.message || fallback,
}));

import api from "../api.js";
import Login from "./Login.jsx";

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <Login />
    </MemoryRouter>
  );
}

describe("Login forgot-password flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens the reset modal and advances to the code step after send", async () => {
    api.post.mockImplementation((url) => {
      if (url === "/auth/forgot-password") {
        return Promise.resolve({
          data: { success: true, message: "If an account exists, sent." },
        });
      }
      return Promise.reject(new Error("unexpected " + url));
    });
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
    expect(screen.getByRole("dialog", { name: "Reset password" })).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("you@gmail.com"), {
      target: { value: "staff@gmail.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));

    expect(await screen.findByPlaceholderText("123456")).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith("/auth/forgot-password", {
      email: "staff@gmail.com",
    });
  });

  it("shows a send error without advancing", async () => {
    api.post.mockRejectedValue(new Error("network down"));
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
    fireEvent.change(screen.getByPlaceholderText("you@gmail.com"), {
      target: { value: "staff@gmail.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));

    expect(await screen.findByText("network down")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("123456")).toBeNull();
  });

  it("blocks mismatched passwords client-side, then redeems on match", async () => {
    api.post.mockImplementation((url) => {
      if (url === "/auth/forgot-password") {
        return Promise.resolve({ data: { success: true, message: "sent" } });
      }
      if (url === "/auth/reset-password") {
        return Promise.resolve({ data: { updated: true } });
      }
      return Promise.reject(new Error("unexpected " + url));
    });
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
    fireEvent.change(screen.getByPlaceholderText("you@gmail.com"), {
      target: { value: "staff@gmail.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    await screen.findByPlaceholderText("123456");

    fireEvent.change(screen.getByPlaceholderText("123456"), {
      target: { value: "482916" },
    });
    // Fill both password fields via their labels.
    fireEvent.change(screen.getByLabelText("New password (min 6)"), {
      target: { value: "newpass12" },
    });
    fireEvent.change(screen.getByLabelText("Confirm new password"), {
      target: { value: "different" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set new password" }));
    expect(await screen.findByText("New passwords do not match.")).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalledWith(
      "/auth/reset-password",
      expect.anything()
    );

    fireEvent.change(screen.getByLabelText("Confirm new password"), {
      target: { value: "newpass12" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set new password" }));
    await screen.findByText("Password updated - sign in with your new password.");
    expect(api.post).toHaveBeenCalledWith("/auth/reset-password", {
      email: "staff@gmail.com",
      code: "482916",
      newPassword: "newpass12",
    });
  });

  it("surfaces an invalid-code server error", async () => {
    api.post.mockImplementation((url) => {
      if (url === "/auth/forgot-password") {
        return Promise.resolve({ data: { success: true, message: "sent" } });
      }
      return Promise.reject(new Error("Invalid or expired code."));
    });
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
    fireEvent.change(screen.getByPlaceholderText("you@gmail.com"), {
      target: { value: "staff@gmail.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    await screen.findByPlaceholderText("123456");

    fireEvent.change(screen.getByPlaceholderText("123456"), {
      target: { value: "000000" },
    });
    fireEvent.change(screen.getByLabelText("New password (min 6)"), {
      target: { value: "newpass12" },
    });
    fireEvent.change(screen.getByLabelText("Confirm new password"), {
      target: { value: "newpass12" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set new password" }));
    expect(await screen.findByText("Invalid or expired code.")).toBeInTheDocument();
  });
});
