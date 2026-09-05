// Shared page header: eyebrow + h1 + sub + actions. Every data page
// uses this so "where am I" reads the same everywhere (Dashboard and
// Analytics already follow this shape with their own headers).
export default function PageHeader({ eyebrow, title, sub, actions }) {
  return (
    <div className="page-header">
      <div>
        {eyebrow && <p className="page-eyebrow">{eyebrow}</p>}
        <h1 className="page-header-title">{title}</h1>
        {sub && <p className="page-header-subtitle">{sub}</p>}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </div>
  );
}
