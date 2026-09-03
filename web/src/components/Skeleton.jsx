export default function Skeleton({ rows = 4, height = 14 }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skel" style={{ width: `${95 - ((i * 13) % 40)}%`, height }} />
      ))}
    </div>
  );
}

export function SkeletonCards({ count = 4 }) {
  return (
    <div className="kpi-grid">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="card">
          <Skeleton rows={3} />
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
