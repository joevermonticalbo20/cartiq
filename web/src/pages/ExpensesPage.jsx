import { useCallback, useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { Trash2, ReceiptText, RefreshCw, X, Plus, Edit2, Wallet } from "lucide-react";
import api, { getErrorMessage } from "../api.js";
import Badge from "../components/Badge.jsx";
import { usePagedData } from "../hooks/usePagedData.js";
import DataTable from "../components/DataTable.jsx";
import EmptyState from "../components/EmptyState.jsx";
import ConfirmDialog from "../components/ConfirmDialog.jsx";
import PageErrorBoundary from "../components/PageErrorBoundary.jsx";
import PageHeader from "../components/PageHeader.jsx";
import { useToast } from "../components/Toast.jsx";
import Select from "../components/Select.jsx";
import { sanitizeMoneyInput, parseMoney } from "../utils/format.js";

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

  // --- NEW STATES FOR ADD & EDIT EXPENSE ---
  const [addOpen, setAddOpen] = useState(false);
  const [addClosing, setAddClosing] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [addError, setAddError] = useState("");
  const [newExpense, setNewExpense] = useState({
    date: new Date().toISOString().split("T")[0],
    vendor: "",
    locationCode: "",
    category: "Supplies",
    amount: "",
    note: ""
  });

  const [editing, setEditing] = useState(null);
  const [editClosing, setEditClosing] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editError, setEditError] = useState("");

  useEffect(() => {
    api.get("/catalog").then(({ data }) => setLocations(data?.locations ?? [])).catch(() => {});
  }, []);

  const path = (p) =>
    `/expenses?page=${p}&pageSize=8` +
    (code ? `&code=${code}` : "") +
    (month ? `&month=${month}` : "") +
    (category ? `&category=${encodeURIComponent(category)}` : "");

  const { rows, meta, loading, error, gotoPage, refresh } = usePagedData(path, [
    code,
    month,
    category,
  ]);

  useEffect(() => {
    if (!loading) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional clock sync when loading flips
      setLastUpdated(new Date());
    }
  }, [loading]);

  const loadSummary = useCallback(async () => {
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
  }, [code, month, category]);

  useEffect(() => {
    const timer = setTimeout(loadSummary, 0);
    return () => clearTimeout(timer);
  }, [loadSummary]);

  function handleRefresh() {
    refresh();
    loadSummary();
  }

  // UX Fix: Global scroll lock para sa modals
  const isAnyModalOpen = addOpen || addClosing || editing || editClosing || Boolean(confirming);
  useEffect(() => {
    if (isAnyModalOpen) document.body.style.overflow = "hidden";
    else document.body.style.overflow = "";
    return () => { document.body.style.overflow = ""; };
  }, [isAnyModalOpen]);

  function closeAddModal() {
    setAddClosing(true);
    setTimeout(() => { setAddOpen(false); setAddClosing(false); }, 150);
  }

  function closeEditModal() {
    setEditClosing(true);
    setTimeout(() => { setEditing(null); setEditClosing(false); }, 150);
  }

  // --- ADD EXPENSE HANDLER ---
  async function handleAddExpense(e) {
    e.preventDefault();
    setAddError("");
    const amount = parseMoney(newExpense.amount);
    if (amount === null || amount <= 0) {
      setAddError("Enter an amount from P0.01 to P9,999,999.99 (whole pesos max 7 digits, up to 2 decimals).");
      return;
    }
    setIsAdding(true);
    try {
      await api.post("/expenses", {
        date: newExpense.date,
        vendor: newExpense.vendor,
        locationCode: newExpense.locationCode || null,
        category: newExpense.category,
        amount,
        note: newExpense.note,
        source: "MANUAL"
      });
      toast(`Expense for ${newExpense.vendor} added`, "success");
      closeAddModal();
      setNewExpense({
        date: new Date().toISOString().split("T")[0],
        vendor: "",
        locationCode: "",
        category: "Supplies",
        amount: "",
        note: ""
      });
      handleRefresh();
    } catch (err) {
      setAddError(getErrorMessage(err, "Failed to add expense."));
    } finally {
      setIsAdding(false);
    }
  }

  // --- EDIT EXPENSE HANDLER ---
  // Only vendor/amount/date/category/note reach the API (location is not
  // editable server-side), so no-change is measured on those fields.
  async function handleEditExpense(e) {
    e.preventDefault();
    setEditError("");
    const amount = parseMoney(editing.amount);
    if (amount === null || amount <= 0) {
      setEditError("Enter an amount from P0.01 to P9,999,999.99 (whole pesos max 7 digits, up to 2 decimals).");
      return;
    }
    const original = rows.find((r) => r.id === editing.id);
    const sameDay = (d) => String(d ?? "").split("T")[0];
    if (
      original &&
      editing.vendor === original.vendor &&
      amount === Math.round(Number(original.amount) * 100) / 100 &&
      sameDay(editing.date) === sameDay(original.date) &&
      editing.category === original.category &&
      (editing.note || "") === (original.note || "")
    ) {
      toast("No changes — nothing to update on this expense.", "info");
      closeEditModal();
      return;
    }
    setIsEditing(true);
    try {
      await api.patch(`/expenses/${editing.id}`, {
        date: editing.date.split("T")[0],
        vendor: editing.vendor,
        locationCode: editing.locationCode || null,
        category: editing.category,
        amount,
        note: editing.note
      });
      toast(`Expense for ${editing.vendor} updated`, "success");
      closeEditModal();
      handleRefresh();
    } catch (err) {
      setEditError(getErrorMessage(err, "Failed to update expense."));
    } finally {
      setIsEditing(false);
    }
  }

  async function doDelete() {
    if (!confirming) return;
    try {
      await api.del(`/expenses/${confirming.id}`);
      toast(`Deleted expense: ${confirming.vendor}`, "success");
      handleRefresh();
    } catch (err) {
      toast(getErrorMessage(err, "Delete failed"), "error");
    } finally {
      setConfirming(null);
    }
  }

  // Options para sa ating custom Select dropdowns (guards para hindi mag-crash)
  const safeLocations = Array.isArray(locations) ? locations : [];
  const locationOptions = [
    { value: "", label: "All carts" },
    ...safeLocations.map((l) => ({ value: l.code, label: `${l.code} - ${l.name}` }))
  ];
  
  // Para sa forms, ayaw natin ng "All carts" o "All categories" blank options
  const formLocationOptions = [
    { value: "", label: "General / No Cart Assigned" },
    ...locations.map((l) => ({ value: l.code, label: `${l.code} - ${l.name}` }))
  ];

  const categoryOptions = [
    { value: "", label: "All categories" },
    ...(summary?.categories ?? ["Supplies", "LPG/Gas", "Maintenance", "Fees/Rent", "Other"]).map((c) => ({ value: c, label: c }))
  ];

  const formCategoryOptions = (summary?.categories ?? ["Supplies", "LPG/Gas", "Maintenance", "Fees/Rent", "Other"]).map((c) => ({ value: c, label: c }));

  return (
    <PageErrorBoundary>
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
              {/* NEW: Add Expense Button */}
              {isOwner && (
                <button
                  className="small-btn"
                  onClick={() => setAddOpen(true)}
                  title="Manually add an expense"
                >
                  <Plus size={14} /> Add Expense
                </button>
              )}
            </div>
          }
        />
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
                style={{ height: "36px" }}
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
          {summary && (summary.by_category ?? []).length > 0 && (
            <div className="flex flex-wrap gap-2" style={{ marginBottom: "var(--space-4)" }}>
              {(summary.by_category ?? []).map((c) => (
                <Badge key={c.category} variant={CATEGORY_CLASS[c.category] ?? "neutral"}>
                  {c.category}: P{Number(c.total).toLocaleString()}
                </Badge>
              ))}
              <Badge variant="brand">
                TOTAL: P{Number(summary.totals?.total_amount ?? 0).toLocaleString()}
              </Badge>
            </div>
          )}
          {error ? (
            <div className="error-box">{error}</div>
          ) : !loading && (!rows || rows.length === 0) ? (
            <EmptyState
              icon={ReceiptText}
              title="No expenses in this period"
              subtitle="Add an expense manually or scan vendor receipts from the POS app."
            />
          ) : (
            <DataTable
              loading={loading}
              fixedLayout={true}
              emptyMessage="No expenses this period."
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
                      <span className="muted small">General</span>
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
                        width: 80,
                        align: "right",
                        render: (e) => (
                          <div className="flex items-center justify-end gap-1">
                            <button
                              className="ghost small-btn"
                              onClick={() => {
                                setEditing({
                                  ...e,
                                  date: new Date(e.date).toISOString().split("T")[0],
                                  locationCode: e.location?.code || ""
                                });
                                setEditError("");
                              }}
                              title="Edit expense"
                            >
                              <Edit2 size={13} />
                            </button>
                            <button
                              className="danger-ghost small-btn"
                              onClick={() => setConfirming(e)}
                              title="Delete expense"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
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

        {/* --- ADD EXPENSE MODAL --- */}
        {(addOpen || addClosing) && (
          <div className={`modal-backdrop ${addClosing ? "is-closing" : ""}`}>
            <div className={`modal ${addClosing ? "is-closing" : ""}`} onClick={(e) => e.stopPropagation()}>
              <h3><Wallet size={22} className="muted"/> Add Manual Expense</h3>
              <p className="muted" style={{ marginBottom: "20px", lineHeight: "1.4" }}>
                Record an expense directly if the receipt scanner isn&apos;t available.
              </p>
              <form onSubmit={handleAddExpense} className="flex flex-col gap-4">
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}>
                  <label className="field">
                    Date
                    <input
                      type="date"
                      required
                      value={newExpense.date}
                      onChange={(e) => setNewExpense({ ...newExpense, date: e.target.value })}
                      style={{ height: "36px" }}
                    />
                  </label>
                  <label className="field">
                    Amount (PHP)
                    <input
                      type="number"
                      min="0"
                      max="9999999.99"
                      step="0.01"
                      required
                      placeholder="0.00"
                      title="Whole pesos max 7 digits, up to 2 decimals"
                      value={newExpense.amount}
                      onChange={(e) => setNewExpense({ ...newExpense, amount: sanitizeMoneyInput(e.target.value) })}
                    />
                  </label>
                </div>
                
                <label className="field">
                  Vendor / Supplier
                  <input
                    type="text"
                    required
                    placeholder="e.g. SM Supermarket"
                    value={newExpense.vendor}
                    onChange={(e) => setNewExpense({ ...newExpense, vendor: e.target.value })}
                  />
                </label>
                
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}>
                  <label className="field">
                    Category
                    <Select
                      value={newExpense.category}
                      onChange={(val) => setNewExpense({ ...newExpense, category: val })}
                      options={formCategoryOptions}
                    />
                  </label>
                  <label className="field">
                    Cart Assignment
                    <Select
                      value={newExpense.locationCode}
                      onChange={(val) => setNewExpense({ ...newExpense, locationCode: val })}
                      options={formLocationOptions}
                    />
                  </label>
                </div>

                <label className="field">
                  Note (Optional)
                  <input
                    type="text"
                    placeholder="Brief description of the purchase"
                    value={newExpense.note}
                    onChange={(e) => setNewExpense({ ...newExpense, note: e.target.value })}
                  />
                </label>
                
                <div className="modal-actions">
                  <button type="button" className="ghost" onClick={closeAddModal} disabled={isAdding || addClosing}>Cancel</button>
                  <button type="submit" disabled={isAdding || addClosing}>
                    {isAdding ? "Adding..." : "Save Expense"}
                  </button>
                </div>
                {addError && <p className="error-box" role="alert" style={{ marginTop: "12px" }}>{addError}</p>}
              </form>
            </div>
          </div>
        )}

        {/* --- EDIT EXPENSE MODAL --- */}
        {(editing || editClosing) && (
          <div className={`modal-backdrop ${editClosing ? "is-closing" : ""}`}>
            <div className={`modal ${editClosing ? "is-closing" : ""}`} onClick={(e) => e.stopPropagation()}>
              <h3><Edit2 size={22} className="muted"/> Edit Expense</h3>
              <p className="muted" style={{ marginBottom: "20px", lineHeight: "1.4" }}>
                Update details for this expense record.
              </p>
              <form onSubmit={handleEditExpense} className="flex flex-col gap-4">
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}>
                  <label className="field">
                    Date
                    <input
                      type="date"
                      required
                      value={editing?.date || ""}
                      onChange={(e) => setEditing({ ...editing, date: e.target.value })}
                      style={{ height: "36px" }}
                    />
                  </label>
                  <label className="field">
                    Amount (PHP)
                    <input
                      type="number"
                      min="0"
                      max="9999999.99"
                      step="0.01"
                      required
                      title="Whole pesos max 7 digits, up to 2 decimals"
                      value={editing?.amount || ""}
                      onChange={(e) => setEditing({ ...editing, amount: sanitizeMoneyInput(e.target.value) })}
                    />
                  </label>
                </div>
                
                <label className="field">
                  Vendor / Supplier
                  <input
                    type="text"
                    required
                    value={editing?.vendor || ""}
                    onChange={(e) => setEditing({ ...editing, vendor: e.target.value })}
                  />
                </label>
                
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}>
                  <label className="field">
                    Category
                    <Select
                      value={editing?.category || "Supplies"}
                      onChange={(val) => setEditing({ ...editing, category: val })}
                      options={formCategoryOptions}
                    />
                  </label>
                  <label className="field">
                    Cart Assignment
                    <Select
                      value={editing?.locationCode || ""}
                      onChange={(val) => setEditing({ ...editing, locationCode: val })}
                      options={formLocationOptions}
                    />
                  </label>
                </div>

                <label className="field">
                  Note (Optional)
                  <input
                    type="text"
                    value={editing?.note || ""}
                    onChange={(e) => setEditing({ ...editing, note: e.target.value })}
                  />
                </label>
                
                <div className="modal-actions">
                  <button type="button" className="ghost" onClick={closeEditModal} disabled={isEditing || editClosing}>Cancel</button>
                  <button type="submit" disabled={isEditing || editClosing}>
                    {isEditing ? "Saving..." : "Save Changes"}
                  </button>
                </div>
                {editError && <p className="error-box" role="alert" style={{ marginTop: "12px" }}>{editError}</p>}
              </form>
            </div>
          </div>
        )}

        {/* --- DELETE CONFIRMATION --- */}
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