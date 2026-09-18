import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ErrorBox from "./ErrorBox.jsx";

describe("ErrorBox", () => {
  it("renders nothing without a message", () => {
    const { container } = render(<ErrorBox message="" />);
    expect(container.firstChild).toBeNull();
  });

  it("uses role=alert so failures are announced", () => {
    render(<ErrorBox message="Something broke" />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Something broke");
    expect(screen.queryByText("Retry")).toBeNull();
  });

  it("offers Retry when a handler is given", () => {
    const onRetry = vi.fn();
    render(<ErrorBox message="Something broke" onRetry={onRetry} />);
    fireEvent.click(screen.getByText("Retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
