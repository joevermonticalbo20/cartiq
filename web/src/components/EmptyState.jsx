export default function EmptyState({
  icon: Icon,
  title,
  subtitle,
  action,
  compact = false,
}) {
  return (
    <div className={`empty-state-card ${compact ? "compact" : ""}`}>
      {Icon && (
        <div className="empty-state-icon" aria-hidden="true">
          <Icon size={compact ? 28 : 36} strokeWidth={1.6} />
        </div>
      )}
      <div className="empty-state-body">
        <strong>{title}</strong>
        {subtitle && <span className="muted small">{subtitle}</span>}
      </div>
      {action && (
        <div className="empty-state-action">
          <button
            type="button"
            onClick={action.onClick}
            className={action.variant === "ghost" ? "ghost" : ""}
            disabled={action.disabled}
          >
            {action.label}
          </button>
        </div>
      )}
    </div>
  );
}
