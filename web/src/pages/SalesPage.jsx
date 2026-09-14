import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { ReceiptText, RefreshCw, X, Download, Edit2 } from "lucide-react";
import api, { getErrorMessage } from "../api.js";
import Badge from "../components/Badge.jsx";
import { usePagedData } from "../hooks/usePagedData.js";
import ConfirmDialog from "../components/ConfirmDialog.jsx";
import DataTable from "../components/DataTable.jsx";
import EmptyState from "../components/EmptyState.jsx";
import PageErrorBoundary from "../components/PageErrorBoundary.jsx";
import PageHeader from "../components/PageHeader.jsx";
import Select from "../components/Select.jsx";
import { useToast } from "../components/Toast.jsx";

export default function SalesPage() {
  const toast = useToast();
  const { user } = useOutletContext();
  const isOwner = user?.role === "OWNER";
  
  const [locations, setLocations] = useState([]);
  const [loc, setLoc] = useState("");
  const [date, setDate] = useState("");
  const [lastUpdated, setLastUpdated] = useState(null);
  
  const [confirming, setConfirming] = useState(null);
  const [exporting, setExporting] = useState(false);

  // --- NEW STATES FOR EDIT ORDER ---
  const [editing, setEditing] = useState(null);
  const [editClosing, setEditClosing] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editError, setEditError] = useState("");

  useEffect(() => {
    api.get("/catalog").then(({ data }) => setLocations(data?.locations ?? [])).catch(() => {});
  }, []);

  const { rows, meta, loading, error, gotoPage, refresh } = usePagedData(
    (p) =>
      `/orders?page=${p}&pageSize=10` +
      (loc ? `&location_code=${loc}` : "") +
      (date ? `&date=${date}` : ""),
    [loc, date]
  );

  useEffect(() => {
    if (!loading) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional clock sync when loading flips
      setLastUpdated(new Date());
    }
  }, [loading]);

  // UX Fix: Global scroll lock para sa Edit modal (gawa niya)
  const isAnyModalOpen = editing || editClosing || Boolean(confirming);
  useEffect(() => {
    if (isAnyModalOpen) document.body.style.overflow = "hidden";
    else document.body.style.overflow = "";
    return () => { document.body.style.overflow = ""; };
  }, [isAnyModalOpen]);

  function closeEditModal() {
    setEditClosing(true);
    setTimeout(() => { setEditing(null); setEditClosing(false); }, 150);
  }

  // --- EXPORT HANDLER (gawa niya) ---
  async function handleExport() {
    setExporting(true);
    try {
      const res = await api.get('/export/sales', {
        params: { month: date ? date.slice(0, 7) : undefined, location_code: loc },
        responseType: 'blob'
      });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sales-${loc || 'all'}-${date || 'all'}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast("Sales exported successfully", "success");
    } catch (err) {
      toast(getErrorMessage(err, "Export failed"), "error");
    } finally {
      setExporting(false);
    }
  }

  // --- EDIT HANDLER (gawa niya) ---
  async function handleEditOrder(e) {
    e.preventDefault();
    setEditError("");
    setIsEditing(true);
    try {
      // Payment correction only — the API rejects any status except VOID,
      // which has its own confirm dialog on the table.
      await api.patch(`/orders/${editing.id}`, {
        paymentMethod: editing.paymentMethod,
      });
      toast(`Order #${editing.id} updated`, "success");
      closeEditModal();
      refresh();
    } catch (err) {
      setEditError(getErrorMessage(err, "Failed to update order."));
    } finally {
      setIsEditing(false);
    }
  }

  // Guards para hindi mag-crash pag null ang locations
  const safeLocations = Array.isArray(locations) ? locations : [];
  const locationOptions = [
    { value: "", label: "All carts" },
    ...safeLocations.map((l) => ({ value: l.code, label: l.code }))
  ];

  async function doVoid() {
    if (!confirming) return;
    try {
      await api.patch(`/orders/${confirming.id}`, { status: "VOID" });
      toast(`Voided order #${confirming.id}`, "success");
      refresh();
    } catch (err) {
      toast(getErrorMessage(err, "Void failed"), "error");
    } finally {
      setConfirming(null);
    }
  }

  // (duplicate locationOptions removed — safe version above is used)


  return (
    <PageErrorBoundary>
      <div className="page-container wide">
        <PageHeader
          eyebrow="Operations"
          title="Sales"
          sub="Every receipt, searchable by cart and day."
          actions={
            <>
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
              {isOwner && (
                <button
                  className="small-btn"
                  onClick={handleExport}
                  disabled={exporting || loading}
                  title="Export current view to Excel"
                >
                  <Download size={14} className={exporting ? "spin" : ""} /> Export
                </button>
              )}
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
                      {(o.items ?? [])
                        .map(
                          (i) =>
                            `${i.qty}x ${i.productName}${i.flavor ? ` (${i.flavor})` : ""}`
                        )
                        .join(", ")}
                    </span>
                  ),
                },
                {
                  key: "payment",
                  label: "Payment",
                  width: 110,
                  render: (o) => <Badge variant="neutral">{o.paymentMethod || "CASH"}</Badge>,
                },
                {
                  key: "staff",
                  label: "Staff",
                  width: 140,
                  render: (o) => <span className="muted">{o.staff?.name ?? "-"}</span>,
                },
                {
                  key: "total",
                  label: (
                    // Mirror of the amount slot below: "Total" is left-aligned
                    // in a 52px slot so its T sits exactly above every P.
                    <span style={{ display: "inline-flex", gap: "8px", whiteSpace: "nowrap" }}>
                      <span style={{ minWidth: "52px", textAlign: "left" }}>Total</span>
                      <span style={{ minWidth: "62px" }} />
                    </span>
                  ),
                  width: 132,
                  align: "right",
                  render: (o) => (
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "flex-end",
                        gap: "8px",
                        whiteSpace: "nowrap",
                      }}
                    >
                      <strong style={{ minWidth: "52px", textAlign: "left" }}>
                        P{o.total}
                      </strong>
                      {/* Empty spacer keeps every amount in the same slot;
                         the VOID badge now lives in the actions cell. */}
                      <span
                        style={{ minWidth: "62px", display: "inline-block" }}
                      />
                    </span>
                  ),
                },
                ...(isOwner
                  ? [
                      {
                        key: "actions",
                        label: "",
                        width: 84,
                        align: "right",
                        render: (o) => (
                          <div className="flex items-center justify-end gap-2">
                            {o.status === "PAID" ? (
                              <>
                                <button
                                  className="ghost small-btn"
                                  onClick={() => {
                                    setEditing({ ...o, paymentMethod: o.paymentMethod || "CASH" });
                                    setEditError("");
                                  }}
                                  title="Edit order"
                                >
                                  <Edit2 size={13} />
                                </button>
                                <button
                                  className="danger-ghost small-btn"
                                  onClick={() => setConfirming(o)}
                                  title="Void order"
                                >
                                  <X size={13} />
                                </button>
                              </>
                            ) : (
                              /* VOID badge centered on the midpoint between the
                                 pen and X buttons: invisible twins preserve the
                                 exact buttons box, badge overlays its center. */
                              <span
                                style={{
                                  position: "relative",
                                  display: "inline-flex",
                                }}
                              >
                                <span
                                  aria-hidden="true"
                                  style={{
                                    visibility: "hidden",
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: "8px",
                                  }}
                                >
                                  <button className="ghost small-btn" disabled tabIndex={-1}>
                                    <Edit2 size={13} />
                                  </button>
                                  <button className="danger-ghost small-btn" disabled tabIndex={-1}>
                                    <X size={13} />
                                  </button>
                                </span>
                                <span
                                  style={{
                                    position: "absolute",
                                    inset: 0,
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                  }}
                                >
                                  <Badge variant={o.status === "REFUNDED" ? "warn" : "danger"}>
                                    {o.status}
                                  </Badge>
                                </span>
                              </span>
                            )}
                          </div>
                        )
                      },
                    ]
                  : []),
              ]}
              data={rows}
              pagination={meta ? { ...meta, onPageChange: gotoPage } : null}
            />
          )}
        </section>

        {/* --- EDIT ORDER MODAL --- */}
        {(editing || editClosing) && (
          <div className={`modal-backdrop ${editClosing ? "is-closing" : ""}`}>
            <div className={`modal ${editClosing ? "is-closing" : ""}`} onClick={(e) => e.stopPropagation()}>
              <h3><Edit2 size={22} className="muted"/> Edit Order #{editing?.id}</h3>
              <p className="muted" style={{ marginBottom: "20px", lineHeight: "1.4" }}>
                Correct a mis-tapped payment method. To fully invalidate an order, use the Void button on the table.
              </p>
              
              <form onSubmit={handleEditOrder} className="flex flex-col gap-4">
                <div>
                  <label className="field">
                    Payment Method
                    <Select
                      value={editing?.paymentMethod || "CASH"}
                      onChange={(val) => setEditing({ ...editing, paymentMethod: val })}
                      options={[
                        { value: "CASH", label: "Cash" },
                        { value: "GCASH", label: "GCash" },
                        { value: "CARD", label: "Card" }
                      ]}
                    />
                  </label>
                </div>
                
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

        <ConfirmDialog
          open={Boolean(confirming)}
          title="Void order?"
          message={
            confirming
              ? `Order #${confirming.id} for P${confirming.total} will stay in history as VOID and stop counting toward sales. Deducted recipe stock will be restored automatically.`
              : ""
          }
          confirmLabel="Void"
          danger
          onConfirm={doVoid}
          onCancel={() => setConfirming(null)}
        />
      </div>
    </PageErrorBoundary>
  );
}