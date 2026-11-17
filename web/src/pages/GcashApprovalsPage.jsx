import { useState, useEffect, useCallback } from "react";
import { useOutletContext } from "react-router-dom";
import { Smartphone, Eye, Check, Ban } from "lucide-react";

import api from "../api.js";
import { getFriendlyError } from "../utils/errors.js";
import { fetchPendingGcash } from "../utils/gcashApprovals.js";
import { useLiveEvent } from "../hooks/useLiveStream.js";
import ConfirmDialog from "../components/ConfirmDialog.jsx";
import VoidNoteField from "../components/VoidNoteField.jsx";
import { validateVoidNote } from "../utils/voidNote.js";
import Badge from "../components/Badge.jsx";
import EmptyState from "../components/EmptyState.jsx";
import ErrorBox from "../components/ErrorBox.jsx";
import PageErrorBoundary from "../components/PageErrorBoundary.jsx";
import PageHeader from "../components/PageHeader.jsx";
import { useToast } from "../components/Toast.jsx";

function itemsPreview(items) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return "";
  const parts = list.slice(0, 2).map((it) =>
    `${Number(it.qty ?? 1)}x ${it.productName ?? "Item"}`,
  );
  return parts.join(", ") + (list.length > 2 ? ` +${list.length - 2} more` : "");
}

export default function GcashApprovalsPage() {
  const toast = useToast();
  const { user } = useOutletContext();
  const isOwner = user?.role === "OWNER";

  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(null); // order being confirmed
  const [confirmPending, setConfirmPending] = useState(false);
  const [rejecting, setRejecting] = useState(null); // order being rejected
  const [rejectNote, setRejectNote] = useState("");
  const [rejectNoteError, setRejectNoteError] = useState("");
  const [rejectPending, setRejectPending] = useState(false);
  const [viewing, setViewing] = useState(null); // receipt viewer state

  const load = useCallback(async () => {
    if (!isOwner) return;
    setLoading(true);
    setError("");
    try {
      const pending = await fetchPendingGcash(api);
      setOrders(pending);
    } catch (err) {
      setError(getFriendlyError(err, "Could not load the GCash queue."));
    } finally {
      setLoading(false);
    }
  }, [isOwner]);

  useEffect(() => {
    const timer = setTimeout(load, 0);
    return () => clearTimeout(timer);
  }, [load]);

  useLiveEvent("alert:new", load);
  useLiveEvent("order:updated", load);

  async function blobErrorMessage(err, fallback) {
    try {
      const blob = err?.response?.data;
      if (blob instanceof Blob) {
        const parsed = JSON.parse(await blob.text());
        if (parsed?.error) return parsed.error;
      }
    } catch {
      /* fall through to generic message */
    }
    return getFriendlyError(err, fallback);
  }

  async function openReceipt(order) {
    setViewing({ order, url: null, loading: true, error: "" });
    try {
      const res = await api.get(`/orders/${order.orderId ?? order.id}/receipt`, { responseType: "blob" });
      const url = URL.createObjectURL(res.data);
      setViewing((prev) => (prev ? { ...prev, url, loading: false } : prev));
    } catch (err) {
      const message = await blobErrorMessage(err, "Could not load the receipt.");
      setViewing((prev) => (prev ? { ...prev, loading: false, error: message } : prev));
    }
  }

  function closeReceipt() {
    setViewing((prev) => {
      if (prev?.url) URL.revokeObjectURL(prev.url);
      return null;
    });
  }

  async function doConfirm() {
    if (!confirming || confirmPending) return;
    setConfirmPending(true);
    try {
      await api.patch(`/orders/${confirming.orderId ?? confirming.id}/gcash-decision`, { decision: "confirm" });
      toast(`Order #${confirming.orderId ?? confirming.id} confirmed - it is now a sale`, "success");
      setConfirming(null);
      await load();
    } catch (err) {
      toast(getFriendlyError(err, "Could not confirm the payment."), "error");
    } finally {
      setConfirmPending(false);
    }
  }

  async function doReject() {
    if (!rejecting || rejectPending) return;
    const check = validateVoidNote(rejectNote);
    if (!check.ok) {
      setRejectNoteError(check.error);
      return;
    }
    setRejectPending(true);
    try {
      await api.patch(`/orders/${rejecting.orderId ?? rejecting.id}/gcash-decision`, { decision: "reject", note: check.value });
      toast(`Order #${rejecting.orderId ?? rejecting.id} declined - not a sale, stock restored`, "success");
      setRejecting(null);
      setRejectNote("");
      setRejectNoteError("");
      await load();
    } catch (err) {
      toast(getFriendlyError(err, "Could not decline the payment."), "error");
    } finally {
      setRejectPending(false);
    }
  }

  const anyBusy = confirmPending || rejectPending;

  return (
    <PageErrorBoundary>
      <div className="page-container wide">
        <PageHeader
          eyebrow="Operations"
          title="GCash approvals"
          sub="Confirm or decline staff GCash payments before they count as sales."
        />

        <section className="panel void-requests-panel">
          <div className={`table-wrap void-requests-table-wrap${!error && !loading && orders.length === 0 ? " is-empty" : ""}`}>
            <table className="data table-fixed void-requests-table">
              <thead>
                <tr>
                  <th className="t-left">Order</th>
                  <th className="void-requests-hide-narrow t-left">Staff</th>
                  <th className="void-requests-hide-narrow t-left">Items</th>
                  <th className="t-right">Total</th>
                  <th className="t-left">Proof</th>
                  <th className="t-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {error ? (
                  <tr><td colSpan={6}><ErrorBox message={error} onRetry={load} /></td></tr>
                ) : loading ? (
                  <tr><td colSpan={6} className="muted small" role="status">Loading GCash orders...</td></tr>
                ) : orders.length === 0 ? (
                  <tr className="void-requests-empty-row">
                    <td colSpan={6} className="void-requests-empty-cell">
                      <EmptyState
                        icon={Smartphone}
                        title="No GCash payments waiting"
                        subtitle="When staff record a GCash sale, it lands here for your confirmation before it counts as a sale."
                      />
                    </td>
                  </tr>
                ) : orders.map((order) => {
                  const id = order.orderId ?? order.id;
                  return (
                    <tr key={id}>
                      <td className="void-requests-order">
                        <strong>#{id}</strong>
                        <span className="muted small" style={{ display: "block" }}>
                          {order.createdAt ? new Date(order.createdAt).toLocaleString() : ""}
                        </span>
                      </td>
                      <td>{order.staffName || "Staff"}</td>
                      <td className="void-requests-hide-narrow small muted">
                        {order.itemCount} item(s) — {itemsPreview(order.items)}
                      </td>
                      <td className="t-right"><strong>₱{Number(order.total ?? 0).toFixed(2)}</strong></td>
                      <td className="t-left">
                        {order.receiptAvailable ? (
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              className="ghost small-btn"
                              onClick={() => openReceipt(order)}
                              aria-label={`View proof for order ${id}`}
                            >
                              <Eye size={13} aria-hidden="true" /> View
                            </button>
                            {order.receiptReplacedAfterRecording && (
                              <Badge variant="warn">Replaced</Badge>
                            )}
                          </div>
                        ) : (
                          <span className="muted small">No photo</span>
                        )}
                      </td>
                      <td className="t-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            className="danger-ghost small-btn"
                            disabled={anyBusy}
                            onClick={() => {
                              setRejecting(order);
                              setRejectNote("");
                              setRejectNoteError("");
                            }}
                          >
                            <Ban size={13} aria-hidden="true" /> Decline
                          </button>
                          <button
                            type="button"
                            className="small-btn"
                            disabled={anyBusy}
                            onClick={() => setConfirming(order)}
                          >
                            <Check size={13} aria-hidden="true" /> Confirm
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {/* --- PROOF PHOTO VIEWER --- */}
        {viewing && (
          <div className="modal-backdrop" onClick={closeReceipt}>
            <div
              className="modal"
              role="dialog"
              aria-modal="true"
              aria-label={`GCash proof for order #${viewing.order?.orderId ?? viewing.order?.id ?? ""}`}
              onClick={(e) => e.stopPropagation()}
            >
              <h3>
                <Eye size={22} className="muted" /> GCash proof — order #{viewing.order?.orderId ?? viewing.order?.id}
              </h3>
              <div
                style={{
                  marginTop: "12px",
                  minHeight: "220px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "var(--surface-alt)",
                  borderRadius: "16px",
                  overflow: "auto",
                }}
              >
                {viewing.loading ? (
                  <p className="muted small" role="status">Loading proof…</p>
                ) : viewing.url ? (
                  <img
                    src={viewing.url}
                    alt="GCash proof"
                    style={{ maxWidth: "100%", maxHeight: "60vh", display: "block" }}
                  />
                ) : (
                  <p className="error-box" role="alert" style={{ margin: 0 }}>
                    {viewing.error || "Proof unavailable."}
                  </p>
                )}
              </div>
              <div className="modal-actions">
                <button
                  type="button"
                  className="ghost"
                  onClick={closeReceipt}
                  disabled={viewing.loading}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}

        {/* --- CONFIRM PAYMENT --- */}
        <ConfirmDialog
          open={Boolean(confirming)}
          title="Confirm this GCash payment?"
          message={
            confirming
              ? `Order #${confirming.orderId ?? confirming.id} for ₱${Number(confirming.total ?? 0).toFixed(2)} will count as a sale. Check the photo against your own GCash transactions first.`
              : ""
          }
          confirmLabel="Confirm payment"
          pending={confirmPending}
          pendingLabel="Confirming..."
          onConfirm={doConfirm}
          onCancel={() => setConfirming(null)}
        />

        {/* --- DECLINE PAYMENT --- */}
        <ConfirmDialog
          open={Boolean(rejecting)}
          title="Decline this payment?"
          message={
            rejecting
              ? `Order #${rejecting.orderId ?? rejecting.id} will not count as a sale. Reserved stock is restored automatically. Give the reason below (staff will see it).`
              : ""
          }
          confirmLabel="Decline payment"
          danger
          pending={rejectPending}
          pendingLabel="Declining..."
          confirmDisabled={!validateVoidNote(rejectNote).ok}
          onConfirm={doReject}
          onCancel={() => {
            setRejecting(null);
            setRejectNote("");
            setRejectNoteError("");
          }}
        >
          <VoidNoteField
            value={rejectNote}
            onChange={setRejectNote}
            error={rejectNoteError}
            onErrorChange={setRejectNoteError}
            autoFocus
          />
        </ConfirmDialog>
      </div>
    </PageErrorBoundary>
  );
}
