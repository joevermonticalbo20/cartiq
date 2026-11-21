import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import CharacterCountInput from "./CharacterCountInput.jsx";

describe("CharacterCountInput", () => {
  it("shows a live count only while a non-empty field is focused", async () => {
    render(<CharacterCountInput aria-label="Staff search" />);
    const input = screen.getByRole("textbox", { name: "Staff search" });

    expect(input).toHaveAttribute("maxLength", "50");
    expect(screen.queryByText("0/50")).toBeNull();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Mia" } });
    expect(screen.getByText("3/50")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "" } });
    expect(screen.queryByText("0/50")).toBeNull();
    fireEvent.change(input, { target: { value: "Mia" } });
    fireEvent.blur(input);
    expect(screen.queryByText("3/50")).toBeNull();

    await userEvent.clear(input);
    await userEvent.type(input, "a".repeat(51));
    expect(input).toHaveValue("a".repeat(50));
    expect(screen.getByText("50/50")).toBeInTheDocument();
  });

  it("uses the field's existing max length and preserves its change handler", () => {
    const onChange = vi.fn();
    render(<CharacterCountInput aria-label="Username" maxLength={8} onChange={onChange} />);
    const input = screen.getByRole("textbox", { name: "Username" });

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "staff01" } });

    expect(input).toHaveAttribute("maxLength", "8");
    expect(screen.getByText("7/8")).toBeInTheDocument();
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
