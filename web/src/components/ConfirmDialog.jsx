import { useEffect, useRef, useState } from "react";

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  danger = false,
  // pending: async onConfirm in flight — disables both buttons so a
  // double-click can't fire the action twice.
  pending = false,
  pendingLabel = null,
  onConfirm,
  onCancel,
}) {
  // renderOpen controls whether the component is actually in the DOM
  const [renderOpen, setRenderOpen] = useState(open);
  // isClosing controls the CSS animation classes
  const [isClosing, setIsClosing] = useState(false);
  const cancelRef = useRef(null);
  const modalRef = useRef(null);
  const previouslyFocused = useRef(null);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- open/close transition drives the exit animation state */
    if (open) {
      // Kapag binuksan, i-render agad at tanggalin ang isClosing state
      setRenderOpen(true);
      setIsClosing(false);
      // Background Scroll Lock
      document.body.style.overflow = "hidden";
    } else if (renderOpen) {
      // Kapag sinara mula sa parent, i-trigger ang closing animation
      setIsClosing(true);
      document.body.style.overflow = "";

      // Maghintay ng 150ms bago tuluyang i-unmount para makapag-play ang fade-out
      const timer = setTimeout(() => {
        setRenderOpen(false);
        setIsClosing(false);
      }, 150);

      return () => clearTimeout(timer);
    } else {
      // Cleanup fallback
      document.body.style.overflow = "";
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open, renderOpen]);

  useEffect(() => {
    if (!renderOpen || isClosing) return;
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
  }, [renderOpen, isClosing]);

  // Kung hindi open at tapos na ang animation, huwag i-render
  if (!renderOpen) return null;

  return (
    // STRICT CLICK-TO-CLOSE: Walang onClick={onCancel} sa backdrop
    <div className={`modal-backdrop ${isClosing ? "is-closing" : ""}`}>
      <div
        ref={modalRef}
        className={`modal ${isClosing ? "is-closing" : ""}`}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()} // Pigilan ang propagation kung sakali
      >
        <h3>{title}</h3>

        {message && (
          <p className="muted" style={{ marginBottom: "20px", lineHeight: "1.4" }}>
            {message}
          </p>
        )}

        <div className="modal-actions">
          <button
            ref={cancelRef}
            type="button"
            className="ghost"
            onClick={onCancel}
            disabled={isClosing || pending} // Para hindi ma-spam ang click habang nagco-close
          >
            Cancel
          </button>

          <button
            type="button"
            className={danger ? "danger" : ""}
            onClick={onConfirm}
            disabled={isClosing || pending}
          >
            {pending && pendingLabel ? pendingLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
