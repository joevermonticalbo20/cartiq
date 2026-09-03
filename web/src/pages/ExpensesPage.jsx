import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { Trash2, ReceiptText } from "lucide-react";
import api from "../api.js";
import { usePagedData } from "../hooks/usePagedData.js";
import DataTable from "../components/DataTable.jsx";
import EmptyState from "../components/EmptyState.jsx";
import ConfirmDialog from "../components/ConfirmDialog.jsx";
import PageErrorBoundary from "../components/PageErrorBoundary.jsx";
import { useToast } from "../components/Toast.jsx";

const CATEGORY_CLASS = {
  Supplies: "brand",
  "LPG/Gas": "critical",
  Maintenance: "low",
  "Fees/Rent": "info",
  Other: "read",
};

export default function ExpensesPage() {
  const toast = useToast();
  const { user } = useOutletContext();
  const isOwner = user?.role === "OWNER";

  const [code, setCode] = useState("");
  const [locations, setLocations] = useState([]);
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [category, setCategory] = useState("");
  const [confirming, setConfirming] = useState(null);
  const [summary, setSummary] = useState(null);

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

  // summary (totals + by_category) comes with every response; use the first
  // page's payload to render the breakdown strip.
  async function loadSummary() {
    try {
      const res = await api.get(
        `/expenses?page=1&pageSize=1` +
          (code ? `&code=${code}` : "") +
          (month ? `&month=${month}` : "")
      );
      setSummary(res.data);
    } catch {
      /* non-critical */
    }
  }

  useEffect(() => {
    const timer = setTimeout(loadSummary, 0);
    return () => clearTimeout(timer);
  }, [code, month]);

  async function doDelete() {
    if (!confirming) return;
    try {
      await api.delete(`/expenses/${confirming.id}`);
      toast(`Deleted expense: ${confirming.vendor}`, "success");
      refresh();
      loadSummary();
    } catch (err) {
      toast(err.response?.data?.error || "Delete failed", "error");
    } finally {
      setConfirming(null);
    }
  }

  return (
    <PageErrorBoundary>
    <div className="page-container">
      <section className="panel">
        <div className="panel-head">
          <h3>Expenses</h3>
          <span className="chip loc">
            {meta ? `${meta.total} record(s) in period` : "..."}
          </span>
        </div>

        <div className="filters">
          <select className="cart-select" value={code} onChange={(e) => setCode(e.target.value)}>
            <option value="">All carts</option>
            {locations.map((l) => (
              <option key={l.id} value={l.code}>{l.code} - {l.name}</option>
            ))}
          </select>
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          <select
            className="cart-select"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="">All categories</option>
            {(summary?.categories ?? ["Supplies", "LPG/Gas", "Maintenance", "Fees/Rent", "Other"]).map(
              (c) => (
                <option key={c} value={c}>{c}</option>
              )
            )}
          </select>
        </div>

        {summary && (
          <div className="filters" style={{ marginBottom: 10 }}>
            {summary.by_category.map((c) => (
              <span key={c.category} className={`chip ${CATEGORY_CLASS[c.category] ?? "read"}`}>
                {c.category}: P{Number(c.total).toLocaleString()}
              </span>
            ))}
            <span className="chip brand">
              TOTAL: P{Number(summary.totals.total_amount).toLocaleString()}
            </span>
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
            emptyMessage="No expenses this period — scan vendor receipts from the mobile POS app."
            columns={[
              {
                key: "date",
                label: "Date",
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
                render: (e) =>
                  e.location ? (
                    <span className="chip loc">{e.location.code}</span>
                  ) : (
                    "-"
                  ),
              },
              {
                key: "category",
                label: "Category",
                render: (e) => (
                  <span className={`chip ${CATEGORY_CLASS[e.category] ?? "read"}`}>
                    {e.category}
                  </span>
                ),
              },
              {
                key: "source",
                label: "Source",
                render: (e) => (
                  <span className={`chip ${e.source === "OCR" ? "low" : "read"}`}>
                    {e.source}
                  </span>
                ),
              },
              {
                key: "note",
                label: "Note",
                render: (e) => (
                  <span className="muted small" style={{ maxWidth: 220 }}>
                    {e.note ?? ""}
                  </span>
                ),
              },
              {
                key: "amount",
                label: "Amount",
                align: "right",
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
