export default function Card({ title, action, children, className = "" }) {
  return (
    <section className={`panel ${className}`}>
      {(title || action) && (
        <div className="panel-head">
          {title && <h3>{title}</h3>}
          {action && <div className="panel-action">{action}</div>}
        </div>
      )}
      <div className="panel-body">{children}</div>
    </section>
  );
}
