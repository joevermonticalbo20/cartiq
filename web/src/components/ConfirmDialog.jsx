import { useEffect, useRef } from "react";
import Button from "./Button.jsx";

// Sticky confirm dialog: backdrop clicks and Escape NEVER dismiss — only an
// explicit Cancel/confirm button closes it. This guards destructive actions
// (logout, void, delete, disable, commit) against accidental dismissal.
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
      // NOTE: Escape intentionally does nothing here (sticky dialog).
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
    <div className="modal-backdrop">
      <div
        ref={modalRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
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
