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

  it("renders an icon badge when icon is provided", () => {
    const { container } = render(
      <ConfirmDialog open={true} title="Log out?" icon={<span data-testid="dlg-icon" />} />
    );
    expect(container.querySelector(".confirm-icon-badge")).not.toBeNull();
    expect(screen.getByTestId("dlg-icon")).toBeInTheDocument();
  });

  it("renders children below the message", () => {
    render(
      <ConfirmDialog open={true} message="You will be signed out.">
        <div data-testid="dlg-child" />
      </ConfirmDialog>
    );
    expect(screen.getByText("You will be signed out.")).toBeInTheDocument();
    expect(screen.getByTestId("dlg-child")).toBeInTheDocument();
  });
});
