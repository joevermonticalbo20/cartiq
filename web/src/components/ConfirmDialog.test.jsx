import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ConfirmDialog from "./ConfirmDialog.jsx";

describe("ConfirmDialog", () => {
  it("renders nothing when closed", () => {
    const { container } = render(<ConfirmDialog open={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders title and message when open", () => {
    render(<ConfirmDialog open={true} title="Delete?" message="Are you sure?" />);
    expect(screen.getByText("Delete?")).toBeInTheDocument();
    expect(screen.getByText("Are you sure?")).toBeInTheDocument();
  });

  it("calls onConfirm when confirm button is clicked", () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog open={true} onConfirm={onConfirm} confirmLabel="Delete" />);
    fireEvent.click(screen.getByText("Delete"));
    expect(onConfirm).toHaveBeenCalled();
  });

  it("calls onCancel when cancel button is clicked", () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog open={true} onCancel={onCancel} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalled();
  });

  it("does NOT dismiss when backdrop is clicked (sticky)", () => {
    const onCancel = vi.fn();
    const { container } = render(<ConfirmDialog open={true} onCancel={onCancel} />);
    const backdrop = container.querySelector(".modal-backdrop");
    fireEvent.click(backdrop);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("does not close when clicking inside the modal", () => {
    const onCancel = vi.fn();
    const { container } = render(<ConfirmDialog open={true} onCancel={onCancel} />);
    const modal = container.querySelector(".modal");
    fireEvent.click(modal);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("focuses Cancel on open", () => {
    render(<ConfirmDialog open={true} onCancel={() => {}} />);
    expect(screen.getByText("Cancel")).toHaveFocus();
  });

  it("traps Tab inside the dialog", () => {
    render(
      <ConfirmDialog open={true} onCancel={() => {}} onConfirm={() => {}} confirmLabel="Delete" />
    );
    const cancel = screen.getByText("Cancel");
    const confirm = screen.getByText("Delete");
    confirm.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(cancel).toHaveFocus();
    cancel.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(confirm).toHaveFocus();
  });

  it("does NOT dismiss on Escape (sticky)", () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog open={true} onCancel={onCancel} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("returns focus to the invoker on close", () => {
    const onCancel = vi.fn();
    const { rerender } = render(
      <div>
        <button>Invoker</button>
        <ConfirmDialog open={false} onCancel={onCancel} />
      </div>
    );
    screen.getByText("Invoker").focus();
    rerender(
      <div>
        <button>Invoker</button>
        <ConfirmDialog open={true} onCancel={onCancel} />
      </div>
    );
    expect(screen.getByText("Cancel")).toHaveFocus();
    rerender(
      <div>
        <button>Invoker</button>
        <ConfirmDialog open={false} onCancel={onCancel} />
      </div>
    );
    expect(screen.getByText("Invoker")).toHaveFocus();
  });
});
