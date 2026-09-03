export default function ConfirmDialog({
  open,
  title = "Are you sure?",
  message,
  confirmLabel = "Confirm",
  danger = false,
  onConfirm,
  onCancel,
}) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p className="muted">{message}</p>
        <div className="modal-actions">
          <button className="ghost" onClick={onCancel}>Cancel</button>
          <button
            className={danger ? "danger" : ""}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
