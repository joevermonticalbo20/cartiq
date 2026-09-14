import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import Select from "./Select.jsx";

const OPTIONS = [
  { value: "", label: "All carts" },
  { value: "CART-01", label: "CART-01" },
  { value: "CART-02", label: "CART-02" },
];

function renderSelect(props = {}) {
  const onChange = vi.fn();
  const utils = render(
    <Select value="" onChange={onChange} options={OPTIONS} {...props} />
  );
  const trigger = screen.getByRole("button");
  return { onChange, trigger, ...utils };
}

describe("Select", () => {
  it("opens on click and selects with the mouse", () => {
    const { onChange, trigger } = renderSelect();
    fireEvent.click(trigger);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.click(screen.getByText("CART-02"));
    expect(onChange).toHaveBeenCalledWith("CART-02");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("opens with ArrowDown and picks the highlighted option on Enter", () => {
    const { onChange, trigger } = renderSelect();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    // Highlight starts on the selected row (index 0); move twice.
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("CART-02");
  });

  it("wraps highlight and closes on Escape without choosing", () => {
    const { onChange, trigger } = renderSelect();
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("CART-02");
  });

  it("Escape closes an open menu without choosing", () => {
    const { onChange, trigger } = renderSelect();
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows an empty state when there are no options", () => {
    renderSelect({ options: [] });
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getByText("No options available")).toBeInTheDocument();
  });

  it("shows the placeholder for a stale value", () => {
    renderSelect({ value: "GONE", placeholder: "Pick one" });
    expect(screen.getByText("Pick one")).toBeInTheDocument();
  });

  it("hides the placeholder option from the menu but shows its label when active", () => {
    const opts = [
      { value: "", label: "Select staff..." },
      { value: "1", label: "Stall Staff 1" },
      { value: "2", label: "Stall Staff 2" },
    ];
    const { trigger } = renderSelect({ options: opts, placeholderValue: "" });
    // Trigger shows the placeholder label while nothing real is picked.
    expect(screen.getByText("Select staff...")).toBeInTheDocument();
    fireEvent.click(trigger);
    const listbox = screen.getByRole("listbox");
    expect(listbox).toBeInTheDocument();
    // Placeholder row is gone from the menu; real options remain.
    expect(within(listbox).queryByText("Select staff...")).toBeNull();
    expect(within(listbox).getByText("Stall Staff 1")).toBeInTheDocument();
    expect(within(listbox).getByText("Stall Staff 2")).toBeInTheDocument();
    fireEvent.click(within(listbox).getByText("Stall Staff 2"));
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
