import { useEffect, useState } from "react";
import { ReceiptText } from "lucide-react";
import api from "../api.js";
import { usePagedData } from "../hooks/usePagedData.js";
import DataTable from "../components/DataTable.jsx";
import EmptyState from "../components/EmptyState.jsx";
import PageErrorBoundary from "../components/PageErrorBoundary.jsx";

export default function SalesPage() {
  const [locations, setLocations] = useState([]);
  const [loc, setLoc] = useState("");
  const [date, setDate] = useState("");

  useEffect(() => {
    api.get("/catalog").then(({ data }) => setLocations(data.locations)).catch(() => {});
  }, []);

  const { rows, meta, loading, error, page, gotoPage, refresh } = usePagedData(
    (p) =>
      `/orders?page=${p}&pageSize=10` +
      (loc ? `&location_code=${loc}` : "") +
      (date ? `&date=${date}` : ""),
    [loc, date]
  );

  return (
    <PageErrorBoundary>
    <div className="page-container">
    <section className="panel">
      <div className="panel-head">
        <h3>Sales transactions</h3>
        <button className="ghost small-btn" onClick={refresh}>Refresh</button>
      </div>

      <div className="filters">
        <select className="cart-select" value={loc} onChange={(e) => setLoc(e.target.value)}>
          <option value="">All carts</option>
          {locations.map((l) => (
            <option key={l.id} value={l.code}>{l.code}</option>
          ))}
        </select>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        {(loc || date) && (
          <button
            className="ghost small-btn"
            onClick={() => {
              setLoc("");
              setDate("");
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {error ? (
        <div className="error-box">{error}</div>
      ) : !loading && (!rows || rows.length === 0) ? (
        <EmptyState
          icon={ReceiptText}
          title="No sales found"
          subtitle={
            loc || date
              ? "Try adjusting or clearing your filters."
              : "Record sales from the POS mobile app and they will show up here."
          }
          action={
            loc || date
              ? { label: "Clear filters", variant: "ghost", onClick: () => { setLoc(""); setDate(""); } }
              : null
          }
        />
      ) : (
        <DataTable
          loading={loading}
          emptyMessage="No sales found — adjust the filters or record sales from the POS app."
          columns={[
            {
              key: "createdAt",
              label: "Date & time",
              render: (o) => new Date(o.createdAt).toLocaleString([], {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              }),
            },
            {
              key: "location",
              label: "Cart",
              render: (o) => <span className="chip loc">{o.location?.code}</span>,
            },
            {
              key: "items",
              label: "Items",
              render: (o) => (
                <span className="muted small" style={{ maxWidth: 380 }}>
                  {o.items
                    .map(
                      (i) =>
                        `${i.qty}x ${i.productName}${i.flavor ? ` (${i.flavor})` : ""}`
                    )
                    .join(", ")}
                </span>
              ),
            },
            {
              key: "staff",
              label: "Staff",
              render: (o) => <span className="muted">{o.staff?.name ?? "-"}</span>,
            },
            {
              key: "total",
              label: "Total",
              align: "right",
              render: (o) => <strong>P{o.total}</strong>,
            },
          ]}
          data={rows}
          pagination={meta ? { ...meta, onPageChange: gotoPage } : null}
        />
      )}
    </section>
    </div>
    </PageErrorBoundary>
  );
}
