import { useEffect, useRef } from "react";
import Button from "./Button.jsx";

export default function ConfirmDialog({
  open,
  title = "Are you sure?",
  message,
  confirmLabel = "Confirm",
  danger = false,
  onConfirm,
  onCancel,
}) {
  const cancelRef = useRef(null);
  const modalRef = useRef(null);
  const previouslyFocused = useRef(null);

  useEffect(() => {
    if (!open) return;
    // Remember the invoker so focus returns to it on close.
    previouslyFocused.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") {
        onCancel?.();
        return;
      }
      // Trap Tab inside the dialog while it is open.
      if (e.key !== "Tab") return;
      const root = modalRef.current;
      if (!root) return;
      const focusables = root.querySelectorAll("button:not([disabled])");
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previouslyFocused.current?.focus?.();
    };
  }, [open, onCancel]);

  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        ref={modalRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="confirm-dialog-title">{title}</h3>
        {message && <p className="muted">{message}</p>}
        <div className="modal-actions">
          <Button ref={cancelRef} variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button
            variant={danger ? "danger" : "primary"}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
