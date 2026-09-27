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
import ForgotPassword from "./ForgotPassword.jsx";

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/forgot-password"]}>
      <ForgotPassword />
    </MemoryRouter>
  );
}

function fillCode(digits = "482916") {
  const boxes = screen.getAllByRole("textbox").filter((el) =>
    el.getAttribute("aria-label")?.startsWith("Digit")
  );
  expect(boxes).toHaveLength(6);
  fireEvent.change(boxes[0], { target: { value: digits } });
  // Pasting one box only fills one digit; fill the rest directly.
  digits
    .split("")
    .forEach((d, i) => fireEvent.change(boxes[i], { target: { value: d } }));
}

describe("ForgotPassword 3-step flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("step 1 sends the code and advances to step 2", async () => {
    api.post.mockResolvedValue({
      data: { success: true, message: "If an account exists, sent." },
    });
    renderPage();

    expect(screen.getByText("STEP 1 OF 3")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Email Address"), {
      target: { value: "staff@gmail.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send Reset Code" }));

    expect(await screen.findByText("STEP 2 OF 3")).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith("/auth/forgot-password", {
      email: "staff@gmail.com",
    });
    expect(screen.getByText("Check Email")).toBeInTheDocument();
  });

  it("verifies the code, shows the banner, and continues to step 3", async () => {
    api.post.mockImplementation((url) => {
      if (url === "/auth/forgot-password") {
        return Promise.resolve({ data: { success: true, message: "sent" } });
      }
      if (url === "/auth/verify-reset-code") {
        return Promise.resolve({ data: { valid: true } });
      }
      return Promise.reject(new Error("unexpected " + url));
    });
    renderPage();

    fireEvent.change(screen.getByLabelText("Email Address"), {
      target: { value: "staff@gmail.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send Reset Code" }));
    await screen.findByText("Check Email");

    fillCode("482916");
    fireEvent.click(screen.getByRole("button", { name: "Verify Code" }));
    expect(
      await screen.findByText("Code verified! You can now reset your password.")
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("STEP 3 OF 3")).toBeInTheDocument();
    expect(screen.getByText("New Password")).toBeInTheDocument();
  });

  it("asks for all 6 digits before calling verify", async () => {
    api.post.mockImplementation((url) => {
      if (url === "/auth/forgot-password") {
        return Promise.resolve({ data: { success: true, message: "sent" } });
      }
      return Promise.reject(new Error("should not be called"));
    });
    renderPage();

    fireEvent.change(screen.getByLabelText("Email Address"), {
      target: { value: "staff@gmail.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send Reset Code" }));
    await screen.findByText("Check Email");

    fillCode("48291");
    fireEvent.click(screen.getByRole("button", { name: "Verify Code" }));
    expect(await screen.findByText("Enter the 6-digit code.")).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it("surfaces an invalid code without advancing", async () => {
    api.post.mockImplementation((url) => {
      if (url === "/auth/forgot-password") {
        return Promise.resolve({ data: { success: true, message: "sent" } });
      }
      return Promise.reject(new Error("Invalid or expired code."));
    });
    renderPage();

    fireEvent.change(screen.getByLabelText("Email Address"), {
      target: { value: "staff@gmail.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send Reset Code" }));
    await screen.findByText("Check Email");

    fillCode("000000");
    fireEvent.click(screen.getByRole("button", { name: "Verify Code" }));
    expect(await screen.findByText("Invalid or expired code.")).toBeInTheDocument();
    expect(screen.queryByText("STEP 3 OF 3")).toBeNull();
  });

  it("blocks mismatched passwords, then completes the reset", async () => {
    api.post.mockImplementation((url) => {
      if (url === "/auth/forgot-password") {
        return Promise.resolve({ data: { success: true, message: "sent" } });
      }
      if (url === "/auth/verify-reset-code") {
        return Promise.resolve({ data: { valid: true } });
      }
      if (url === "/auth/reset-password") {
        return Promise.resolve({ data: { updated: true } });
      }
      return Promise.reject(new Error("unexpected " + url));
    });
    renderPage();

    fireEvent.change(screen.getByLabelText("Email Address"), {
      target: { value: "staff@gmail.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send Reset Code" }));
    await screen.findByText("Check Email");
    fillCode("482916");
    fireEvent.click(screen.getByRole("button", { name: "Verify Code" }));
    await screen.findByText("Code verified! You can now reset your password.");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("New Password");

    fireEvent.change(screen.getByLabelText("Create New Password"), {
      target: { value: "newpass12" },
    });
    fireEvent.change(screen.getByLabelText("Confirm New Password"), {
      target: { value: "different" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reset Password" }));
    expect(await screen.findByText("New passwords do not match.")).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalledWith(
      "/auth/reset-password",
      expect.anything()
    );

    fireEvent.change(screen.getByLabelText("Confirm New Password"), {
      target: { value: "newpass12" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reset Password" }));
    expect(await screen.findByText("Password updated")).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith("/auth/reset-password", {
      email: "staff@gmail.com",
      code: "482916",
      newPassword: "newpass12",
    });
  });

  it("resend re-requests a code for the same address", async () => {
    api.post.mockResolvedValue({ data: { success: true, message: "sent" } });
    renderPage();

    fireEvent.change(screen.getByLabelText("Email Address"), {
      target: { value: "staff@gmail.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send Reset Code" }));
    await screen.findByText("Check Email");

    fireEvent.click(screen.getByRole("button", { name: "Resend" }));
    await vi.waitFor(() => {
      expect(api.post).toHaveBeenCalledTimes(2);
    });
    expect(api.post).toHaveBeenLastCalledWith("/auth/forgot-password", {
      email: "staff@gmail.com",
    });
  });
});
