import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ShoppingBag } from "lucide-react";
import EmptyState from "./EmptyState.jsx";

describe("EmptyState", () => {
  it("renders title and subtitle", () => {
    render(
      <EmptyState
        icon={ShoppingBag}
        title="Nothing here"
        subtitle="Add items to see them appear"
      />
    );
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
    expect(screen.getByText("Add items to see them appear")).toBeInTheDocument();
  });

  it("renders an action button and clicks it", () => {
    const onClick = vi.fn();
    render(
      <EmptyState
        icon={ShoppingBag}
        title="Empty"
        action={{ label: "Add now", onClick }}
      />
    );
    fireEvent.click(screen.getByText("Add now"));
    expect(onClick).toHaveBeenCalled();
  });

  it("renders the ghost variant for secondary actions", () => {
    render(
      <EmptyState
        icon={ShoppingBag}
        title="Empty"
        action={{ label: "Reset filters", onClick: () => {}, variant: "ghost" }}
      />
    );
    const button = screen.getByText("Reset filters");
    expect(button.className).toContain("ghost");
  });
});
