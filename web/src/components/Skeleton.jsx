export default function Skeleton({ rows = 4, height = 14, widths = [95, 78, 88, 62] }) {
  return (
    <div className="skeleton-lines" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="skel"
          style={{ width: `${widths[i % widths.length]}%`, height }}
        />
      ))}
    </div>
  );
}

export function TableSkeleton({
  columns,
  rows = 5,
  compact = false,
  fixedLayout = false,
  className = "",
  tableClassName = "",
  ariaLabel = "Loading table",
}) {
  const columnWidths = [68, 52, 78, 62, 44];

  return (
    <div className={`table-wrap ${className}`.trim()} tabIndex={0} role="region" aria-label={ariaLabel}>
      <table className={["data", compact ? "compact" : "", fixedLayout ? "table-fixed" : "", tableClassName].filter(Boolean).join(" ")}>
        <thead>
          <tr>
            {columns.map((column, index) => {
              const col = typeof column === "string" ? { key: column, label: column } : column;
              return (
                <th
                  key={col.key ?? col.label ?? index}
                  style={col.width ? { width: col.width, minWidth: col.width } : undefined}
                  className={[col.align ? `t-${col.align}` : "", compact ? "compact-th" : "", col.className ?? ""].filter(Boolean).join(" ")}
                >
                  <span className="th-inner">{col.label}</span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }).map((_, rowIndex) => (
            <tr key={rowIndex}>
              {columns.map((column, columnIndex) => {
                const col = typeof column === "string" ? { key: column, label: column } : column;
                const type = col.skeletonType
                  ?? (col.key === "actions" ? "actions" : undefined);

                return (
                  <td
                    key={col.key ?? col.label ?? columnIndex}
                    className={[col.align ? `t-${col.align}` : "", compact ? "compact-td" : "", col.className ?? ""].filter(Boolean).join(" ")}
                  >
                    {type === "actions" ? (
                      <span className="table-skeleton-actions" aria-hidden="true">
                        <span className="skel" />
                        <span className="skel" />
                      </span>
                    ) : type === "button-actions" ? (
                      <span className="table-skeleton-button-actions" aria-hidden="true">
                        <span className="skel" />
                        <span className="skel" />
                        <span className="skel" />
                      </span>
                    ) : (
                      <span
                        className={`skel table-skeleton-cell${type === "badge" ? " is-badge" : ""}${type === "checkbox" ? " is-checkbox" : ""}`}
                        aria-hidden="true"
                        style={{
                          width: type === "badge" ? 56 : type === "checkbox" ? 16 : col.skeletonWidth ?? `${columnWidths[columnIndex % columnWidths.length]}%`,
                        }}
                      />
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SkeletonList({ rows = 4, className = "", card = false }) {
  return (
    <div className={`skeleton-list ${className}`.trim()} aria-hidden="true">
      {Array.from({ length: rows }).map((_, index) => (
        <div className={`skeleton-list-row${card ? " is-card" : ""}`} key={index}>
          <span className="skel skeleton-list-avatar" />
          <span className="skeleton-list-copy">
            <span className="skel" />
            <span className="skel" />
          </span>
          <span className="skel skeleton-list-badge" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonCards({ count = 4, className = "kpi-grid" }) {
  return (
    <div className={className}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="kpi-card skeleton-kpi-card" aria-hidden="true">
          <div className="skeleton-kpi-header">
            <span className="skel" />
            <span className="skel" />
          </div>
          <span className="skel skeleton-kpi-value" />
          <div className="skeleton-kpi-footer">
            <span className="skel" />
            <span className="skel" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function SkeletonChart({ height = 220 }) {
  return (
    <div className="card" aria-hidden="true">
      <div className="skel" style={{ width: "38%", height: 16 }} />
      <div className="skel" style={{ height, marginTop: "var(--space-3)" }} />
      <div style={{ display: "flex", gap: 8, marginTop: "var(--space-3)" }}>
        <div className="skel" style={{ flex: 1, height: 12 }} />
        <div className="skel" style={{ flex: 1, height: 12 }} />
        <div className="skel" style={{ flex: 1, height: 12 }} />
      </div>
    </div>
  );
}
