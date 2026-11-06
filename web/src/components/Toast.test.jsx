import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ToastProvider, useToast } from "./Toast.jsx";

function Probe({ onPush }) {
  const push = useToast();
  onPush(push);
  return null;
}

function renderWithProbe() {
  let push;
  const { container } = render(
    <ToastProvider>
      <Probe onPush={(p) => { push = p; }} />
    </ToastProvider>
  );
  const count = () => container.querySelectorAll(".toast").length;
  return { push: (...args) => act(() => push(...args)), count, container };
}

describe("ToastProvider flood control", () => {
  it("shows a single pushed toast", () => {
    const { push, count } = renderWithProbe();
    push("hello", "info");
    expect(count()).toBe(1);
    expect(screen.getByText("hello")).toBeInTheDocument();
  });

  it("caps visible toasts, evicting oldest first", () => {
    const { push, count, container } = renderWithProbe();
    for (let i = 1; i <= 6; i++) push(`msg-${i}`, "info");
    expect(count()).toBe(4);
    expect(container.textContent).not.toContain("msg-1");
    expect(container.textContent).not.toContain("msg-2");
    expect(container.textContent).toContain("msg-6");
  });

  it("deduplicates identical visible toasts", () => {
    const { push, count } = renderWithProbe();
    push("same", "error");
    push("same", "error");
    push("same", "error");
    expect(count()).toBe(1);
  });

  it("limits distinct error bursts to two visible alerts", () => {
    const { push, count, container } = renderWithProbe();
    push("error-1", "error");
    push("error-2", "error");
    push("error-3", "error");
    expect(count()).toBe(2);
    expect(container.textContent).not.toContain("error-1");
    expect(container.textContent).toContain("error-3");
  });

  it("keeps distinct messages and preserves error role", () => {
    const { push, count } = renderWithProbe();
    push("one", "info");
    push("two", "error");
    expect(count()).toBe(2);
    expect(screen.getByText("two").closest(".toast")).toHaveAttribute("role", "alert");
  });

  it("renders warning toasts with a heading and warning style", () => {
    const { push } = renderWithProbe();
    push("Review this change", "warn");
    expect(screen.getByText("Heads up")).toBeInTheDocument();
    expect(screen.getByText("Review this change").closest(".toast")).toHaveClass("warning");
  });

  it("dismisses via the close button", () => {
    vi.useFakeTimers();
    const { push, count, container } = renderWithProbe();
    push("bye", "info");
    expect(count()).toBe(1);
    fireEvent.click(container.querySelector(".toast-close"));
    expect(container.querySelector(".toast")).toHaveClass("toast--exiting");
    act(() => vi.advanceTimersByTime(220));
    expect(count()).toBe(0);
    vi.useRealTimers();
  });
});
