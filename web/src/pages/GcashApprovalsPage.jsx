import { useState, useEffect, useCallback } from "react";
import { useOutletContext, useSearchParams } from "react-router-dom";
import { Smartphone, Eye, Check, Ban, Square, CheckSquare } from "lucide-react";

import api from "../api.js";
import { getFriendlyError } from "../utils/errors.js";
import { fetchPendingGcash } from "../utils/gcashApprovals.js";
import { useLiveEvent } from "../hooks/useLiveStream.js";
import ConfirmDialog from "../components/ConfirmDialog.jsx";
import VoidNoteField from "../components/VoidNoteField.jsx";
import { TableSkeleton } from "../components/Skeleton.jsx";
import { validateVoidNote } from "../utils/voidNote.js";
import Badge from "../components/Badge.jsx";
import EmptyState from "../components/EmptyState.jsx";
import ErrorBox from "../components/ErrorBox.jsx";
import PageErrorBoundary from "../components/PageErrorBoundary.jsx";
import PageHeader from "../components/PageHeader.jsx";
import { useToast } from "../components/Toast.jsx";
import useNotificationHighlight from "../hooks/useNotificationHighlight.js";

function itemsPreview(items) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return "";
  const parts = list.slice(0, 2).map((it) =>
    `${Number(it.qty ?? 1)}x ${it.productName ?? "Item"}`,
  );
  return parts.join(", ") + (list.length > 2 ? ` +${list.length - 2} more` : "");
}

// One numeric id for every backend/caller: pending-gcash rows carry both.
function rowId(order) {
  return order?.orderId ?? order?.id;
}

const GCASH_DECLINE_REASONS = [
  { value: "Transaction not found in GCash account", label: "Transaction not found in GCash account" },
  { value: "Amount does not match order total", label: "Amount does not match order total" },
  { value: "Receipt is unclear or appears invalid", label: "Receipt is unclear or appears invalid" },
  { value: "Duplicate payment submission", label: "Duplicate payment submission" },
  { value: "Other / specific reason", label: "Other / type a specific reason" },
];

export default function GcashApprovalsPage() {
  const toast = useToast();
  const { user } = useOutletContext();
  const isOwner = user?.role === "OWNER";
  const [searchParams] = useSearchParams();
  const notificationOrderId = searchParams.get("orderId");

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
  const [selected, setSelected] = useState(new Set());
  const [confirmBulk, setConfirmBulk] = useState(null); // "confirm" | "reject" | null
  const [bulkPending, setBulkPending] = useState(false);
  const [bulkRejectNote, setBulkRejectNote] = useState("");
  const [bulkRejectNoteError, setBulkRejectNoteError] = useState("");
  const activeHighlight = useNotificationHighlight(
    notificationOrderId ? `order:${notificationOrderId}` : null,
    !loading && !error,
  );

  const load = useCallback(async () => {
    if (!isOwner) return;
    setLoading(true);
    setError("");
    try {
      const pending = await fetchPendingGcash(api);
      setOrders(pending);
      setSelected((current) => {
        const valid = new Set(pending.map((order) => rowId(order)));
        return new Set([...current].filter((id) => valid.has(id)));
      });
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
  useLiveEvent("orders:updated", load);

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
      const res = await api.get(`/orders/${rowId(order)}/receipt`, { responseType: "blob" });
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
      await api.patch(`/orders/${rowId(confirming)}/gcash-decision`, { decision: "confirm" });
      toast(`Order #${rowId(confirming)} confirmed - it is now a sale`, "success");
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
      await api.patch(`/orders/${rowId(rejecting)}/gcash-decision`, { decision: "reject", note: check.value });
      toast(`Order #${rowId(rejecting)} declined - not a sale, stock restored`, "success");
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

  const toggleOne = (id) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === orders.length && orders.length > 0) {
      setSelected(new Set());
    } else {
      setSelected(new Set(orders.map((order) => rowId(order))));
    }
  };

  async function runBulk(decision) {
    if (bulkPending) return;
    let payloadNote;
    if (decision === "reject") {
      const check = validateVoidNote(bulkRejectNote);
      if (!check.ok) {
        setBulkRejectNoteError(check.error);
        return;
      }
      payloadNote = check.value;
    }

    setBulkPending(true);
    const targets = orders.filter((order) => selected.has(rowId(order)));
    let okCount = 0;
    const failed = [];
    for (const order of targets) {
      const id = rowId(order);
      try {
        await api.patch(
          `/orders/${id}/gcash-decision`,
          decision === "confirm" ? { decision } : { decision, note: payloadNote },
        );
        okCount++;
      } catch {
        failed.push(order);
      }
    }
    setBulkPending(false);
    setConfirmBulk(null);
    setBulkRejectNote("");
    setBulkRejectNoteError("");
    await load();
    toast(
      failed.length === 0
        ? (decision === "confirm"
            ? `Confirmed ${okCount} GCash payment(s) - now counted as sales`
            : `Declined ${okCount} GCash payment(s) - stock restored`)
        : `${okCount} succeeded, ${failed.length} failed. Remaining payments are still listed.`,
      failed.length === 0 ? "success" : "error",
    );
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
          {loading && !error ? (
            <TableSkeleton
              ariaLabel="Loading GCash approvals"
              className="void-requests-table-wrap"
              tableClassName="table-fixed void-requests-table gcash-approvals-table"
              fixedLayout
              columns={[
                { key: "select", label: "", width: 44, skeletonType: "checkbox", className: "void-requests-select-col" },
                { key: "order", label: "Order", className: "t-left gcash-approvals-order", skeletonWidth: "55%" },
                { key: "staff", label: "Staff", className: "gcash-approvals-staff t-left", skeletonWidth: "66%" },
                { key: "items", label: "Items", className: "void-requests-hide-narrow gcash-approvals-items t-left", skeletonWidth: "70%" },
                { key: "total", label: "Total", align: "right", skeletonWidth: "48%" },
                { key: "proof", label: "Proof", className: "gcash-approvals-proof t-left", skeletonType: "badge" },
                { key: "actions", label: "", align: "right", className: "gcash-approvals-actions", skeletonType: "actions" },
              ]}
            />
          ) : (
          <div className={`table-wrap void-requests-table-wrap${!error && !loading && orders.length === 0 ? " is-empty" : ""}`}>
            <table className="data table-fixed void-requests-table gcash-approvals-table">
              <thead>
                <tr>
                  <th className="void-requests-select-col" aria-label="Select"></th>
                  <th className="t-left gcash-approvals-order">Order</th>
                  <th className="gcash-approvals-staff t-left">Staff</th>
                  <th className="void-requests-hide-narrow gcash-approvals-items t-left">Items</th>
                  <th className="gcash-approvals-total t-right">Total</th>
                  <th className="gcash-approvals-proof t-left">Proof</th>
                  <th className="gcash-approvals-actions t-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {error ? (
                  <tr><td colSpan={7}><ErrorBox message={error} onRetry={load} /></td></tr>
                ) : orders.length === 0 ? (
                  <tr className="void-requests-empty-row">
                    <td colSpan={7} className="void-requests-empty-cell">
                      <EmptyState
                        icon={Smartphone}
                        title="No GCash payments waiting"
                        subtitle="When staff record a GCash sale, it lands here for your confirmation before it counts as a sale."
                      />
                    </td>
                  </tr>
                ) : orders.map((order) => {
                  const id = rowId(order);
                  return (
                    <tr
                      key={id}
                      data-notification-target={`order:${id}`}
                      className={[
                        selected.has(id) ? "row-selected" : "",
                        activeHighlight === `order:${id}` ? "notification-target-highlight" : "",
                      ].filter(Boolean).join(" ") || undefined}
                    >
                      <td>
                        <input
                          type="checkbox"
                          checked={selected.has(id)}
                          disabled={anyBusy || bulkPending}
                          onChange={() => toggleOne(id)}
                          aria-label={`Select GCash payment for order ${id}`}
                        />
                      </td>
                      <td className="void-requests-order gcash-approvals-order-cell">
                        <strong>#{id}</strong>
                        <span className="muted small" style={{ display: "block" }}>
                          {order.createdAt
                            ? new Date(order.createdAt).toLocaleString([], {
                                month: "short",
                                day: "numeric",
                                hour: "numeric",
                                minute: "2-digit",
                              })
                            : ""}
                        </span>
                      </td>
                      <td className="gcash-approvals-staff-cell">{order.staffName || "Staff"}</td>
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
                            disabled={anyBusy || bulkPending}
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
                            disabled={anyBusy || bulkPending}
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
          )}

          {!error && !loading && orders.length > 0 && (
            <div className="void-requests-toolbar">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  className="ghost small-btn"
                  onClick={toggleAll}
                  disabled={bulkPending}
                  aria-label="Toggle select all"
                >
                  {orders.length > 0 && selected.size === orders.length
                    ? <CheckSquare size={16} aria-hidden="true" />
                    : <Square size={16} aria-hidden="true" />}
                  {orders.length > 0 && selected.size === orders.length ? " Deselect all" : " Select all"}
                </button>
                <span className="muted small">{selected.size} of {orders.length} selected</span>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="danger-ghost small-btn"
                  disabled={selected.size === 0 || bulkPending}
                  onClick={() => {
                    setConfirmBulk("reject");
                    setBulkRejectNote("");
                    setBulkRejectNoteError("");
                  }}
                >
                  <Ban size={13} aria-hidden="true" /> Decline selected
                </button>
                <button
                  type="button"
                  className="small-btn"
                  disabled={selected.size === 0 || bulkPending}
                  onClick={() => setConfirmBulk("confirm")}
                >
                  <Check size={13} aria-hidden="true" /> Confirm selected
                </button>
              </div>
            </div>
          )}
        </section>

        <ConfirmDialog
          open={Boolean(confirmBulk)}
          title={confirmBulk === "confirm" ? "Confirm selected GCash payments?" : "Decline selected GCash payments?"}
          message={
            confirmBulk === "confirm"
              ? `${selected.size} payment(s) will count as sales. Confirm only after checking each proof against your GCash transactions.`
              : `${selected.size} payment(s) will not count as sales. Reserved stock will be restored and the staff will see the reason.`
          }
          confirmLabel={confirmBulk === "confirm" ? "Confirm selected" : "Decline selected"}
          danger={confirmBulk === "reject"}
          pending={bulkPending}
          pendingLabel="Working..."
          confirmDisabled={confirmBulk === "reject" && !validateVoidNote(bulkRejectNote).ok}
          onConfirm={() => runBulk(confirmBulk)}
          onCancel={() => {
            setConfirmBulk(null);
            setBulkRejectNote("");
            setBulkRejectNoteError("");
          }}
        >
          {confirmBulk === "reject" && (
            <VoidNoteField
              value={bulkRejectNote}
              onChange={setBulkRejectNote}
              error={bulkRejectNoteError}
              onErrorChange={setBulkRejectNoteError}
              autoFocus
              label="Decline reason"
              options={GCASH_DECLINE_REASONS}
            />
          )}
        </ConfirmDialog>

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
              ? `Order #${rowId(confirming)} for ₱${Number(confirming.total ?? 0).toFixed(2)} will count as a sale. Check the photo against your own GCash transactions first.`
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
            label="Decline reason"
            options={GCASH_DECLINE_REASONS}
          />
        </ConfirmDialog>
      </div>
    </PageErrorBoundary>
  );
}
