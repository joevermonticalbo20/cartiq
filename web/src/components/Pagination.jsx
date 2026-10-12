import { ChevronLeft, ChevronRight } from "lucide-react";

export default function Pagination({ meta, onPage }) {
  if (!meta || meta.totalPages <= 1) {
    return meta?.total > 0 ? (
      <div className="pagination">
        {meta.total} record{meta.total === 1 ? "" : "s"}
      </div>
    ) : null;
  }
  
  const { page, totalPages, total } = meta;

  // Smart Pagination Logic (Ellipsis Pattern)
  const getPageNumbers = () => {
    const pages = [];
    if (totalPages <= 7) {
      // Show all pages if 7 or fewer
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      // Dynamic rendering with ellipsis for large datasets
      if (page <= 4) {
        pages.push(1, 2, 3, 4, 5, '...', totalPages);
      } else if (page >= totalPages - 3) {
        pages.push(1, '...', totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages);
      } else {
        pages.push(1, '...', page - 1, page, page + 1, '...', totalPages);
      }
    }
    return pages;
  };

  const numbers = getPageNumbers();

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
          style={{ display: "inline-flex", alignItems: "center", gap: "4px", padding: "0 14px" }}
        >
          <ChevronLeft size={16} /> Prev
        </button>
        
        {numbers.map((p, i) => (
          p === '...' ? (
            <span 
              key={`ellipsis-${i}`} 
              className="muted" 
              style={{ display: "flex", alignItems: "center", padding: "0 4px", userSelect: "none" }}
              aria-hidden="true"
            >
              &hellip;
            </span>
          ) : (
            <button
              key={p}
              className={`page-btn ${p === page ? "current" : ""}`}
              onClick={() => onPage(p)}
              aria-label={`Page ${p}`}
              aria-current={p === page ? "page" : undefined}
            >
              {p}
            </button>
          )
        ))}

        <button
          className="page-btn"
          disabled={page >= totalPages}
          onClick={() => onPage(page + 1)}
          aria-label="Next page"
          style={{ display: "inline-flex", alignItems: "center", gap: "4px", padding: "0 14px" }}
        >
          Next <ChevronRight size={16} />
        </button>
      </div>
    </nav>
  );
}