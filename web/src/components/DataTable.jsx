import { useState } from "react";
import { ChevronUp, ChevronDown, ChevronsUpDown, Inbox } from "lucide-react";
import Pagination from "./Pagination.jsx";
import EmptyState from "./EmptyState.jsx";

export default function DataTable({
  columns,
  data,
  onRowClick,
  emptyMessage = "Nothing to display here",
  loading = false,
  sortable = false,
  onSort,
  pagination,
  compact = false,
}) {
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState("asc");

  if (loading) {
    return (
      <div className="table-wrap">
        <table className={`data${compact ? " compact" : ""}`}>
          <thead>
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  style={col.width ? { width: col.width } : undefined}
                  className={col.align ? `t-${col.align}` : undefined}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 5 }).map((_, i) => (
              <tr key={i}>
                {columns.map((col) => (
                  <td key={col.key} className={col.align ? `t-${col.align}` : undefined}>
                    <div className="skel" style={{ width: `${90 - (i * 11) % 50}%`, height: 14 }} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (!data || data.length === 0) {
    return <EmptyState icon={Inbox} title={emptyMessage} compact />;
  }

  function handleSort(key) {
    const dir = sortKey === key && sortDir === "asc" ? "desc" : "asc";
    setSortKey(key);
    setSortDir(dir);
    onSort?.(key, dir);
  }

  return (
    <>
      <div className="table-wrap">
        <table className={`data${compact ? " compact" : ""}`}>
          <thead>
            <tr>
              {columns.map((col) => {
                const canSort = col.sortable && onSort;
                const isActive = sortKey === col.key;
                return (
                  <th
                    key={col.key}
                    style={col.width ? { width: col.width } : undefined}
                    className={[
                      col.align ? `t-${col.align}` : undefined,
                      canSort ? "sortable-th" : "",
                      compact ? "compact-th" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={canSort ? () => handleSort(col.key) : undefined}
                  >
                    <span className="th-inner">
                      {col.label}
                      {canSort && (
                        <span className="sort-icon" aria-hidden="true">
                          {isActive ? (
                            sortDir === "asc" ? (
                              <ChevronUp size={13} />
                            ) : (
                              <ChevronDown size={13} />
                            )
                          ) : (
                            <ChevronsUpDown size={13} />
                          )}
                        </span>
                      )}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {data.map((row, i) => (
              <tr
                key={row.id ?? i}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                style={onRowClick ? { cursor: "pointer" } : undefined}
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={[
                      col.align ? `t-${col.align}` : undefined,
                      compact ? "compact-td" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    {col.render ? col.render(row) : row[col.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pagination && (
        <Pagination meta={pagination} onPage={pagination.onPageChange} />
      )}
    </>
  );
}
