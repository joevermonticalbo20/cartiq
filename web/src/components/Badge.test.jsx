import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import Badge from "./Badge.jsx";

describe("Badge", () => {
  it("renders canonical variants", () => {
    const { rerender } = render(<Badge variant="danger">Hot</Badge>);
    expect(screen.getByText("Hot")).toHaveClass("chip", "critical");
    rerender(<Badge variant="warn">Warm</Badge>);
    expect(screen.getByText("Warm")).toHaveClass("chip", "low");
    rerender(<Badge variant="brand">New</Badge>);
    expect(screen.getByText("New")).toHaveClass("chip", "brand");
  });

  it("resolves legacy aliases to the same classes", () => {
    const { rerender } = render(<Badge variant="critical">A</Badge>);
    expect(screen.getByText("A")).toHaveClass("chip", "critical");
    rerender(<Badge variant="read">B</Badge>);
    expect(screen.getByText("B")).toHaveClass("chip", "read");
    rerender(<Badge variant="loc">C</Badge>);
    expect(screen.getByText("C")).toHaveClass("chip", "info");
    rerender(<Badge variant="low">D</Badge>);
    expect(screen.getByText("D")).toHaveClass("chip", "low");
  });

  it("defaults to neutral and passes props through", () => {
    render(<Badge title="Why">E</Badge>);
    const el = screen.getByText("E");
    expect(el).toHaveClass("chip", "read");
    expect(el).toHaveAttribute("title", "Why");
  });
});
