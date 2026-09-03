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
