import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { Trash2, ReceiptText, RefreshCw, X } from "lucide-react";
import api from "../api.js";
import Badge from "../components/Badge.jsx";
import { usePagedData } from "../hooks/usePagedData.js";
import DataTable from "../components/DataTable.jsx";
import EmptyState from "../components/EmptyState.jsx";
import ConfirmDialog from "../components/ConfirmDialog.jsx";
import PageErrorBoundary from "../components/PageErrorBoundary.jsx";
import PageHeader from "../components/PageHeader.jsx";
import { useToast } from "../components/Toast.jsx";
import Select from "../components/Select.jsx";

const CATEGORY_CLASS = {
  Supplies: "brand",
  "LPG/Gas": "danger",
  Maintenance: "warn",
  "Fees/Rent": "info",
  Other: "neutral",
};

export default function ExpensesPage() {
  const toast = useToast();
  const { user } = useOutletContext();
  const isOwner = user?.role === "OWNER";
  
  const currentMonth = new Date().toISOString().slice(0, 7);
  const [code, setCode] = useState("");
  const [locations, setLocations] = useState([]);
  const [month, setMonth] = useState(currentMonth);
  const [category, setCategory] = useState("");
  
  const [confirming, setConfirming] = useState(null);
  const [summary, setSummary] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  useEffect(() => {
    api.get("/catalog").then(({ data }) => setLocations(data.locations)).catch(() => {});
  }, []);

  const path = (p) =>
    `/expenses?page=${p}&pageSize=8` +
    (code ? `&code=${code}` : "") +
    (month ? `&month=${month}` : "") +
    (category ? `&category=${encodeURIComponent(category)}` : "");

  const { rows, meta, loading, error, page, gotoPage, refresh } = usePagedData(path, [
    code,
    month,
    category,
  ]);

  // Update ang Last Updated timestamp kapag natapos mag-load
  useEffect(() => {
    if (!loading) {
      setLastUpdated(new Date());
    }
  }, [loading]);

  // summary (totals + by_category) comes with every response; use the first
  // page's payload to render the breakdown strip. Includes the category
  // filter so the strip never disagrees with the table.
  async function loadSummary() {
    try {
      const res = await api.get(
        `/expenses?page=1&pageSize=1` +
          (code ? `&code=${code}` : "") +
          (month ? `&month=${month}` : "") +
          (category ? `&category=${encodeURIComponent(category)}` : "")
      );
      setSummary(res.data);
    } catch {
      /* non-critical */
    }
  }

  useEffect(() => {
    const timer = setTimeout(loadSummary, 0);
    return () => clearTimeout(timer);
  }, [code, month, category]);

  function handleRefresh() {
    refresh();
    loadSummary();
  }

  async function doDelete() {
    if (!confirming) return;
    try {
      await api.del(`/expenses/${confirming.id}`);
      toast(`Deleted expense: ${confirming.vendor}`, "success");
      handleRefresh();
    } catch (err) {
      toast(err.response?.data?.error || "Delete failed", "error");
    } finally {
      setConfirming(null);
    }
  }

  // Options para sa ating custom Select dropdowns
  const locationOptions = [
    { value: "", label: "All carts" },
    ...locations.map((l) => ({ value: l.code, label: `${l.code} - ${l.name}` }))
  ];

  const categoryOptions = [
    { value: "", label: "All categories" },
    ...(summary?.categories ?? ["Supplies", "LPG/Gas", "Maintenance", "Fees/Rent", "Other"]).map((c) => ({ value: c, label: c }))
  ];

  return (
    <PageErrorBoundary>
      {/* Nilagyan natin ng wide class para lumapad gaya ng Sales/Analytics */}
      <div className="page-container wide">
        <PageHeader
          eyebrow="Operations"
          title="Expenses"
          sub="Vendor costs by month and category."
          actions={
            <div className="flex items-center gap-3 flex-wrap">
              {meta && (
                <Badge variant="info">
                  {meta.total} record(s)
                </Badge>
              )}
              <span className="muted small" style={{ marginLeft: "4px" }}>
                Last updated {lastUpdated?.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) ?? "just now"}
              </span>
              <button
                className="ghost small-btn"
                onClick={handleRefresh}
                disabled={loading}
                title="Refresh expenses"
              >
                <RefreshCw size={14} className={loading ? "spin" : ""} /> Refresh
              </button>
            </div>
          }
        />

        {/* Ginamit natin ang sales-panel css para makuha ang malinis na soft-panel UI */}
        <section className="panel sales-panel">
          <div className="sales-filters-row">
            <div className="sales-filters-left">
              <Select 
                value={code} 
                onChange={(val) => setCode(val)} 
                options={locationOptions} 
                placeholder="All carts" 
              />
              <input 
                type="month" 
                value={month} 
                onChange={(e) => setMonth(e.target.value)} 
                title="Filter by month"
                style={{ height: "36px" }} // Para kapantay ng Select dropdown
              />
              <Select 
                value={category} 
                onChange={(val) => setCategory(val)} 
                options={categoryOptions} 
                placeholder="All categories" 
              />
            </div>

            {(code || month !== currentMonth || category) && (
              <button
                className="danger-ghost small-btn"
                onClick={() => {
                  setCode("");
                  setMonth(currentMonth);
                  setCategory("");
                }}
              >
                <X size={14} /> Clear filters
              </button>
            )}
          </div>

          {summary && summary.by_category.length > 0 && (
            <div className="flex flex-wrap gap-2" style={{ marginBottom: "var(--space-4)" }}>
              {summary.by_category.map((c) => (
                <Badge key={c.category} variant={CATEGORY_CLASS[c.category] ?? "neutral"}>
                  {c.category}: P{Number(c.total).toLocaleString()}
                </Badge>
              ))}
              <Badge variant="brand">
                TOTAL: P{Number(summary.totals.total_amount).toLocaleString()}
              </Badge>
            </div>
          )}

          {error ? (
            <div className="error-box">{error}</div>
          ) : !loading && (!rows || rows.length === 0) ? (
            <EmptyState
              icon={ReceiptText}
              title="No expenses in this period"
              subtitle="Scan vendor receipts from the mobile POS app and they'll appear here automatically."
            />
          ) : (
            <DataTable
              loading={loading}
              fixedLayout={true} // Ginawang fixed ang table layout
              emptyMessage="No expenses this period - scan vendor receipts from the mobile POS app."
              columns={[
                {
                  key: "date",
                  label: "Date",
                  width: 100,
                  render: (e) => (
                    <span className="muted">
                      {new Date(e.date).toLocaleDateString()}
                    </span>
                  ),
                },
                {
                  key: "vendor",
                  label: "Vendor",
                  render: (e) => <strong>{e.vendor}</strong>,
                },
                {
                  key: "location",
                  label: "Cart",
                  width: 120,
                  render: (e) =>
                    e.location ? (
                      <Badge variant="info">{e.location.code}</Badge>
                    ) : (
                      "-"
                    ),
                },
                {
                  key: "category",
                  label: "Category",
                  width: 130,
                  render: (e) => (
                    <Badge variant={CATEGORY_CLASS[e.category] ?? "neutral"}>
                      {e.category}
                    </Badge>
                  ),
                },
                {
                  key: "source",
                  label: "Source",
                  width: 100,
                  render: (e) => (
                    <Badge variant={e.source === "OCR" ? "warn" : "neutral"}>
                      {e.source}
                    </Badge>
                  ),
                },
                {
                  key: "note",
                  label: "Note",
                  render: (e) => (
                    <span className="muted small">
                      {e.note ?? ""}
                    </span>
                  ),
                },
                {
                  key: "amount",
                  label: "Amount",
                  align: "right",
                  width: 120,
                  render: (e) => (
                    <strong>P{Number(e.amount).toLocaleString()}</strong>
                  ),
                },
                ...(isOwner
                  ? [
                      {
                        key: "actions",
                        label: "",
                        width: 48,
                        align: "right",
                        render: (e) => (
                          <button
                            className="danger-ghost small-btn"
                            onClick={() => setConfirming(e)}
                            title="Delete expense"
                          >
                            <Trash2 size={13} />
                          </button>
                        ),
                      },
                    ]
                  : []),
              ]}
              data={rows}
              pagination={meta ? { ...meta, onPageChange: gotoPage } : null}
            />
          )}
        </section>

        <ConfirmDialog
          open={Boolean(confirming)}
          title="Delete expense?"
          message={
            confirming
              ? `"${confirming.vendor}" for P${confirming.amount} will be permanently removed.`
              : ""
          }
          confirmLabel="Delete"
          danger
          onConfirm={doDelete}
          onCancel={() => setConfirming(null)}
        />
      </div>
    </PageErrorBoundary>
  );
}