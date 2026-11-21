import { useId, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

export default function Pagination({ meta, onPage }) {
  const [jumpValue, setJumpValue] = useState(() => meta?.page ? String(meta.page) : "");
  const jumpInputId = useId();

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
  const goToPage = (target) => {
    setJumpValue(String(target));
    if (target !== page) onPage(target);
  };
  const jumpToPage = (event) => {
    event.preventDefault();
    const target = Number.parseInt(jumpValue, 10);
    if (!Number.isFinite(target)) return;
    const safeTarget = Math.min(Math.max(target, 1), totalPages);
    goToPage(safeTarget);
  };

  return (
    <nav className="pagination" aria-label="Table pages">
      <div className="pagination-summary">
        <strong>{total.toLocaleString()}</strong>
        <span>record{total === 1 ? "" : "s"}</span>
      </div>
      <div className="pagination-center">
        <div className="page-btns" aria-label="Pagination controls">
          <button
            className="page-btn page-btn-direction"
            disabled={page <= 1}
            onClick={() => goToPage(page - 1)}
            aria-label="Previous page"
            title="Previous page"
          >
            <ChevronLeft size={17} />
            <span>Prev</span>
          </button>

          {numbers.map((p, i) => (
            p === '...' ? (
              <span
                key={`ellipsis-${i}`}
                className="page-ellipsis"
                aria-hidden="true"
              >
                &hellip;
              </span>
            ) : (
              <button
                key={p}
                className={`page-btn ${p === page ? "current" : ""}`}
                onClick={() => goToPage(p)}
                aria-label={`Page ${p}`}
                aria-current={p === page ? "page" : undefined}
              >
                {p}
              </button>
            )
          ))}

          <button
            className="page-btn page-btn-direction"
            disabled={page >= totalPages}
            onClick={() => goToPage(page + 1)}
            aria-label="Next page"
            title="Next page"
          >
            <span>Next</span>
            <ChevronRight size={17} />
          </button>
        </div>
      </div>
      <form className="page-jump" onSubmit={jumpToPage} noValidate>
        <label htmlFor={jumpInputId} className="page-jump-label">Jump to</label>
        <div className="page-jump-field">
          <input
            id={jumpInputId}
            className="page-jump-input"
            type="number"
            inputMode="numeric"
            min={1}
            max={totalPages}
            value={jumpValue}
            onChange={(event) => setJumpValue(event.target.value)}
            aria-label="Page number"
          />
          <span className="page-jump-total">/ {totalPages}</span>
        </div>
        <button type="submit" className="page-jump-go">Go</button>
      </form>
    </nav>
  );
}