export default function Pagination({ meta, onPage }) {
  if (!meta || meta.totalPages <= 1) {
    return meta?.total > 0 ? (
      <div className="pagination">
        {meta.total} record{meta.total === 1 ? "" : "s"}
      </div>
    ) : null;
  }
  const { page, totalPages, total } = meta;

  const numbers = [];
  const start = Math.max(1, Math.min(page - 2, totalPages - 4));
  for (let p = start; p <= Math.min(start + 4, totalPages); p++) numbers.push(p);

  return (
    <nav className="pagination" aria-label="Table pages">
      <span>
        {total} record{total === 1 ? "" : "s"} · page {page} of {totalPages}
      </span>
      <div className="page-btns">
        <button
          className="page-btn"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          aria-label="Previous page"
        >
          ‹
        </button>
        {numbers.map((p) => (
          <button
            key={p}
            className={`page-btn ${p === page ? "current" : ""}`}
            onClick={() => onPage(p)}
            aria-label={`Page ${p}`}
            aria-current={p === page ? "page" : undefined}
          >
            {p}
          </button>
        ))}
        <button
          className="page-btn"
          disabled={page >= totalPages}
          onClick={() => onPage(page + 1)}
          aria-label="Next page"
        >
          ›
        </button>
      </div>
    </nav>
  );
}
