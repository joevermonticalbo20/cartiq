import { useEffect, useState } from "react";
import { ReceiptText, RefreshCw, X } from "lucide-react";
import api from "../api.js";
import Badge from "../components/Badge.jsx";
import { usePagedData } from "../hooks/usePagedData.js";
import DataTable from "../components/DataTable.jsx";
import EmptyState from "../components/EmptyState.jsx";
import PageErrorBoundary from "../components/PageErrorBoundary.jsx";
import PageHeader from "../components/PageHeader.jsx";
import Select from "../components/Select.jsx";

export default function SalesPage() {
  const [locations, setLocations] = useState([]);
  const [loc, setLoc] = useState("");
  const [date, setDate] = useState("");
  const [lastUpdated, setLastUpdated] = useState(null);

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

  // Awtomatikong kukuha ng bagong oras tuwing matatapos mag-load ang table data
  useEffect(() => {
    if (!loading) {
      setLastUpdated(new Date());
    }
  }, [loading]);

  const locationOptions = [
    { value: "", label: "All carts" },
    ...locations.map((l) => ({ value: l.code, label: l.code }))
  ];

  return (
    <PageErrorBoundary>
      <div className="page-container wide">
        <PageHeader
          eyebrow="Operations"
          title="Sales"
          sub="Every receipt, searchable by cart and day."
          actions={
            <>
              {/* Idinagdag natin ang Last updated text dito */}
              <span className="muted small" style={{ marginRight: "4px" }}>
                Last updated {lastUpdated?.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) ?? "just now"}
              </span>
              <button 
                className="ghost small-btn" 
                onClick={refresh} 
                disabled={loading} 
                title="Refresh sales"
              >
                <RefreshCw size={14} className={loading ? "spin" : ""} /> Refresh
              </button>
            </>
          }
        />
        
        <section className="panel sales-panel">
          <div className="sales-filters-row">
            <div className="sales-filters-left">
              <Select 
                value={loc} 
                onChange={(val) => setLoc(val)} 
                options={locationOptions} 
              />
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            
            {(loc || date) && (
              <button
                className="danger-ghost small-btn"
                onClick={() => {
                  setLoc("");
                  setDate("");
                }}
              >
                <X size={14} /> Clear filters
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
            />
          ) : (
            <DataTable
              loading={loading}
              fixedLayout={true}
              emptyMessage="No sales found - adjust the filters or record sales from the POS app."
              columns={[
                {
                  key: "createdAt",
                  label: "Date & time",
                  width: 150,
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
                  width: 100,
                  render: (o) => <Badge variant="info">{o.location?.code}</Badge>,
                },
                {
                  key: "items",
                  label: "Items",
                  render: (o) => (
                    <span className="muted small" style={{ display: "block" }}>
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
                  width: 140,
                  render: (o) => <span className="muted">{o.staff?.name ?? "-"}</span>,
                },
                {
                  key: "total",
                  label: "Total",
                  width: 110,
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