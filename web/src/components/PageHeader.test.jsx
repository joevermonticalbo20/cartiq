import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import PageHeader from "./PageHeader.jsx";

describe("PageHeader", () => {
  it("renders eyebrow, h1 title, sub, and actions", () => {
    render(
      <PageHeader
        eyebrow="Operations"
        title="Sales"
        sub="Every receipt, searchable."
        actions={<button>Refresh</button>}
      />
    );
    expect(screen.getByText("Operations")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Sales" })).toBeInTheDocument();
    expect(screen.getByText("Every receipt, searchable.")).toBeInTheDocument();
    expect(screen.getByText("Refresh")).toBeInTheDocument();
  });

  it("omits empty slots", () => {
    const { container } = render(<PageHeader title="Plain" />);
    expect(container.querySelector(".page-eyebrow")).toBeNull();
    expect(container.querySelector(".page-header-subtitle")).toBeNull();
    expect(container.querySelector(".page-header-actions")).toBeNull();
  });
});
