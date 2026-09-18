/**
 * Consistent error surface: alert role for screen readers plus an optional
 * Retry action (Inventory/Analytics pattern). Replaces ad-hoc
 * `<div className="error-box">` blocks that had no role or no retry.
 */
export default function ErrorBox({ message, onRetry, retryLabel = "Retry", style }) {
  if (!message) return null;
  return (
    <div
      className="error-box"
      role="alert"
      style={{ ...(onRetry ? { display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" } : null), ...style }}
    >
      <span style={{ flex: "1 1 auto" }}>{message}</span>
      {onRetry && (
        <button type="button" className="ghost small-btn" onClick={onRetry}>
          {retryLabel}
        </button>
      )}
    </div>
  );
}
