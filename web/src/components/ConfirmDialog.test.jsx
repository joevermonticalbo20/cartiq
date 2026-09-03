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

  it("calls onCancel when backdrop is clicked", () => {
    const onCancel = vi.fn();
    const { container } = render(<ConfirmDialog open={true} onCancel={onCancel} />);
    const backdrop = container.querySelector(".modal-backdrop");
    fireEvent.click(backdrop);
    expect(onCancel).toHaveBeenCalled();
  });

  it("does not close when clicking inside the modal", () => {
    const onCancel = vi.fn();
    const { container } = render(<ConfirmDialog open={true} onCancel={onCancel} />);
    const modal = container.querySelector(".modal");
    fireEvent.click(modal);
    expect(onCancel).not.toHaveBeenCalled();
  });
});
