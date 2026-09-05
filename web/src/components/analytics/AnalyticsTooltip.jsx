// Shared recharts tooltip shell — one place owns the container
// classes (.recharts-default-tooltip + .analytics-tooltip in
// analytics.css). Charts keep their own rows inside.
export default function AnalyticsTooltip({ label, children }) {
  return (
    <div className="recharts-default-tooltip analytics-tooltip">
      {label != null && <div className="recharts-tooltip-label">{label}</div>}
      {children}
    </div>
  );
}

export function TooltipItem({ children, muted = false }) {
  return (
    <div className={`recharts-tooltip-item${muted ? " muted small" : ""}`}>
      {children}
    </div>
  );
}
