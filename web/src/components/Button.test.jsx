import { describe, it, expect, vi } from "vitest";
import { createRef } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import Button from "./Button.jsx";

describe("Button", () => {
  it("renders primary by default with type=button", () => {
    render(<Button>Save</Button>);
    const btn = screen.getByText("Save");
    expect(btn.tagName).toBe("BUTTON");
    expect(btn).toHaveAttribute("type", "button");
  });

  it("maps ghost and danger variants to classes", () => {
    const { rerender } = render(<Button variant="ghost">Back</Button>);
    expect(screen.getByText("Back")).toHaveClass("ghost");
    rerender(<Button variant="danger">Delete</Button>);
    expect(screen.getByText("Delete")).toHaveClass("danger");
  });

  it("applies small-btn when small", () => {
    render(<Button small>Tiny</Button>);
    expect(screen.getByText("Tiny")).toHaveClass("small-btn");
  });

  it("forwards refs to the native button", () => {
    const ref = createRef();
    render(<Button ref={ref}>Focus me</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });

  it("calls onClick", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    fireEvent.click(screen.getByText("Go"));
    expect(onClick).toHaveBeenCalled();
  });
});
