import Button from "./Button.jsx";

export default function EmptyState({
  icon: Icon,
  title,
  subtitle,
  action,
  compact = false,
}) {
  return (
    // Tailwind pilot: utilities mirror the legacy .empty-state-card rules
    // (flex column, centered, gap-2.5 = 10px). Legacy classes stay as the
    // tiebreak since styles.css loads after tailwind.css.
    <div className={`empty-state-card flex flex-col items-center text-center gap-2.5 ${compact ? "compact" : ""}`}>
      {Icon && (
        <div className="empty-state-icon grid place-items-center rounded-full" aria-hidden="true">
          <Icon size={compact ? 28 : 36} strokeWidth={1.6} />
        </div>
      )}
      <div className="empty-state-body flex flex-col gap-1">
        <strong>{title}</strong>
        {subtitle && <span className="muted small">{subtitle}</span>}
      </div>
      {action && (
        <div className="empty-state-action">
          <Button
            variant={action.variant === "ghost" ? "ghost" : "primary"}
            onClick={action.onClick}
            disabled={action.disabled}
          >
            {action.label}
          </Button>
        </div>
      )}
    </div>
  );
}
