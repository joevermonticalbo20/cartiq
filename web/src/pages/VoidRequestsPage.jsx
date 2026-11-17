import { useState, useEffect, useCallback } from "react";
import { useOutletContext } from "react-router-dom";
import { Hourglass, Check, Ban, Square, CheckSquare } from "lucide-react";

import api from "../api.js";
import { getFriendlyError } from "../utils/errors.js";
import { fetchAllVoidRequests } from "../utils/voidRequests.js";
import { useLiveEvent } from "../hooks/useLiveStream.js";
import ConfirmDialog from "../components/ConfirmDialog.jsx";
import VoidNoteField from "../components/VoidNoteField.jsx";
import { validateVoidNote } from "../utils/voidNote.js";
import EmptyState from "../components/EmptyState.jsx";
import ErrorBox from "../components/ErrorBox.jsx";
import PageErrorBoundary from "../components/PageErrorBoundary.jsx";
import PageHeader from "../components/PageHeader.jsx";
import { useToast } from "../components/Toast.jsx";

function orderIdOf(request) {
  let orderId = request?.orderId ?? null;
  try {
    orderId = JSON.parse(request?.payload ?? "{}")?.orderId ?? orderId;
  } catch {
    /* keep whatever the alert carried at the top level */
  }
  return orderId ? Number(orderId) : null;
}

export default function VoidRequestsPage() {
  const toast = useToast();
  const { user } = useOutletContext();
  const isOwner = user?.role === "OWNER";

  const [voidRequests, setVoidRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [deciding, setDeciding] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [confirmBulk, setConfirmBulk] = useState(null); // "approve" | "deny" | null
  const [bulkPending, setBulkPending] = useState(false);
  const [decidingRequest, setDecidingRequest] = useState(null); // { request, decision }
  const [decisionNote, setDecisionNote] = useState("");
  const [decisionNoteError, setDecisionNoteError] = useState("");
  const [decisionPending, setDecisionPending] = useState(false);
  const [bulkNote, setBulkNote] = useState("");
  const [bulkNoteError, setBulkNoteError] = useState("");

  const load = useCallback(async () => {
    if (!isOwner) return;
    setLoading(true);
    setError("");
    try {
      const pending = await fetchAllVoidRequests(api);
      setVoidRequests(pending);
      setSelected((current) => {
        const valid = new Set(pending.map((r) => r.id));
        return new Set([...current].filter((id) => valid.has(id)));
      });
    } catch (err) {
      setError(getFriendlyError(err, "Could not load void requests."));
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

  const toggleOne = (id) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === voidRequests.length && voidRequests.length > 0) {
      setSelected(new Set());
    } else {
      setSelected(new Set(voidRequests.map((r) => r.id)));
    }
  };

  function decideOne(request, decision) {
    setDecidingRequest({ request, decision });
    setDecisionNote("");
    setDecisionNoteError("");
  }

  async function doDecide() {
    if (!decidingRequest || decisionPending) return;
    const { request, decision } = decidingRequest;
    const orderId = orderIdOf(request);
    if (!orderId) {
      toast("This request has no order reference.", "error");
      return;
    }
    const check = validateVoidNote(decisionNote);
    if (!check.ok) {
      setDecisionNoteError(check.error);
      return;
    }
    setDecisionPending(true);
    setDeciding(request.id);
    try {
      await api.patch(`/orders/${orderId}/void-request`, { decision, note: check.value });
      toast(
        decision === "approve"
          ? `Order #${orderId} voided - stock restored`
          : `Order #${orderId} stays as paid`,
        "success",
      );
      setDecidingRequest(null);
      await load();
    } catch (err) {
      toast(getFriendlyError(err, "Could not record the void decision."), "error");
    } finally {
      setDecisionPending(false);
      setDeciding(null);
    }
  }

  function closeDecisionDialog() {
    setDecidingRequest(null);
    setDecisionNote("");
    setDecisionNoteError("");
  }

  async function runBulk(decision) {
    if (bulkPending) return;
    const check = validateVoidNote(bulkNote);
    if (!check.ok) {
      setBulkNoteError(check.error);
      return;
    }
    setBulkPending(true);
    const note = check.value;
    const targets = voidRequests.filter((r) => selected.has(r.id));
    let okCount = 0;
    const failed = [];
    for (const req of targets) {
      const orderId = orderIdOf(req);
      if (!orderId) { failed.push(req); continue; }
      setDeciding(req.id);
      try {
        await api.patch(`/orders/${orderId}/void-request`, { decision, note });
        okCount++;
      } catch {
        failed.push(req);
      } finally {
        setDeciding(null);
      }
    }
    setBulkPending(false);
    setConfirmBulk(null);
    setBulkNote("");
    setBulkNoteError("");
    await load();
    toast(
      failed.length === 0
        ? (decision === "approve"
            ? `Voided ${okCount} order(s) - stock restored`
            : `Denied ${okCount} request(s) - orders stay as paid`)
        : `${okCount} succeeded, ${failed.length} failed. Remaining requests are still listed.`,
      failed.length === 0 ? "success" : "error"
    );
  }

  const allSelected = voidRequests.length > 0 && selected.size === voidRequests.length;
  const someSelected = selected.size > 0;
  // indeterminate state is derived on the fly in the header checkbox.

  if (!isOwner) {
    return (
      <PageErrorBoundary>
        <div className="page-container wide">
          <PageHeader eyebrow="Operations" title="Void requests" sub="Owner-only: approving or denying void requests requires owner access." />
          <EmptyState
            icon={Hourglass}
            title="Owner only"
            subtitle="Ask an administrator to handle void requests."
            compact
          />
        </div>
      </PageErrorBoundary>
    );
  }

  return (
    <PageErrorBoundary>
      <div className="page-container wide">
        <PageHeader
          eyebrow="Operations"
          title="Void requests"
          sub="Staff-filed void requests waiting for your decision."
        />

        <section className="panel void-requests-panel">
          {!error && !loading && voidRequests.length > 0 && (
              <div className="void-requests-toolbar">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    className="ghost small-btn"
                    onClick={toggleAll}
                    disabled={bulkPending}
                    aria-label="Toggle select all"
                  >
                    {allSelected ? <CheckSquare size={16} aria-hidden="true" /> : <Square size={16} aria-hidden="true" />}
                    {allSelected ? " Deselect all" : " Select all"}
                  </button>
                  <span className="muted small">{selected.size} of {voidRequests.length} selected</span>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="danger-ghost small-btn"
                    disabled={!someSelected || bulkPending}
                    onClick={() => {
                      setConfirmBulk("deny");
                      setBulkNote("");
                      setBulkNoteError("");
                    }}
                  >
                    <Ban size={13} aria-hidden="true" /> Deny selected
                  </button>
                  <button
                    type="button"
                    className="small-btn"
                    disabled={!someSelected || bulkPending}
                    onClick={() => {
                      setConfirmBulk("approve");
                      setBulkNote("");
                      setBulkNoteError("");
                    }}
                  >
                    <Check size={13} aria-hidden="true" /> Void selected
                  </button>
                </div>
              </div>
          )}

          <div
            className={`table-wrap void-requests-table-wrap${!error && !loading && voidRequests.length === 0 ? " is-empty" : ""}`}
          >
            <table className="data table-fixed void-requests-table">
              <thead>
                <tr>
                  <th className="void-requests-select-col" aria-label="Select"></th>
                  <th className="t-left">Order</th>
                  <th className="void-requests-hide-narrow t-left">Requester</th>
                  <th className="void-requests-hide-narrow t-left">Reason</th>
                  <th className="void-requests-hide-narrow t-left">Requested</th>
                  <th className="t-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {error ? (
                  <tr><td colSpan={6}><ErrorBox message={error} onRetry={load} /></td></tr>
                ) : loading ? (
                  <tr><td colSpan={6} className="muted small" role="status">Loading void requests...</td></tr>
                ) : voidRequests.length === 0 ? (
                  <tr className="void-requests-empty-row">
                    <td colSpan={6} className="void-requests-empty-cell">
                      <EmptyState
                        icon={Check}
                        title="No void requests waiting"
                        subtitle="Approved and denied requests are cleared from this list automatically."
                      />
                    </td>
                  </tr>
                ) : voidRequests.map((req) => {
                  const orderId = orderIdOf(req);
                  const busy = deciding === req.id;
                  return (
                    <tr key={req.id} className={selected.has(req.id) ? "row-selected" : undefined}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selected.has(req.id)}
                          disabled={bulkPending || busy}
                          onChange={() => toggleOne(req.id)}
                          aria-label={`Select void request for order ${orderId ?? "?"}`}
                        />
                      </td>
                      <td className="void-requests-order"><strong>#{orderId ?? "?"}</strong></td>
                      <td className="void-requests-hide-narrow">{req.requestedByName || "Staff"}</td>
                      <td className="void-requests-hide-narrow small muted">
                        {req.reason || "—"}
                      </td>
                      <td className="void-requests-hide-narrow small muted">
                        {req.createdAt ? new Date(req.createdAt).toLocaleString() : "—"}
                      </td>
                      <td className="t-right">
                        <div className="void-requests-actions">
                          <button
                            type="button"
                            className="danger-ghost small-btn"
                            disabled={deciding !== null || bulkPending}
                            onClick={() => decideOne(req, "deny")}
                          >
                            <Ban size={13} aria-hidden="true" /> Deny
                          </button>
                          <button
                            type="button"
                            className="small-btn"
                            disabled={deciding !== null || bulkPending}
                            onClick={() => decideOne(req, "approve")}
                          >
                            <Check size={13} aria-hidden="true" /> Approve
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

        <ConfirmDialog
          open={Boolean(confirmBulk)}
          title={confirmBulk === "approve" ? "Void selected orders?" : "Deny selected requests?"}
          message={
            confirmBulk === "approve"
              ? `${selected.size} order(s) will be voided and stock restored for each. Give the reason for each.`
              : `${selected.size} request(s) will be denied; those orders stay as paid. Give the reason for each.`
          }
          confirmLabel={confirmBulk === "approve" ? "Void selected" : "Deny selected"}
          danger={confirmBulk === "approve"}
          pending={bulkPending}
          pendingLabel="Working..."
          confirmDisabled={!validateVoidNote(bulkNote).ok}
          onConfirm={() => runBulk(confirmBulk)}
          onCancel={() => {
            setConfirmBulk(null);
            setBulkNote("");
            setBulkNoteError("");
          }}
        >
          <VoidNoteField
            value={bulkNote}
            onChange={setBulkNote}
            error={bulkNoteError}
            onErrorChange={setBulkNoteError}
            autoFocus
            label={confirmBulk === "approve" ? "Reason for void" : "Decline reason"}
          />
        </ConfirmDialog>

        <ConfirmDialog
          open={Boolean(decidingRequest)}
          title={decidingRequest?.decision === "approve" ? "Void this order?" : "Deny the void request?"}
          danger={decidingRequest?.decision === "approve"}
          message={
            decidingRequest
              ? decidingRequest.decision === "approve"
                ? `Order #${orderIdOf(decidingRequest.request) ?? "?"} will be voided and its deducted stock restored. This cannot be undone.`
                : `Order #${orderIdOf(decidingRequest.request) ?? "?"} stays as paid. The staff member will see the reason.`
              : ""
          }
          confirmLabel={decidingRequest?.decision === "approve" ? "Void order" : "Deny request"}
          pending={decisionPending}
          pendingLabel={decidingRequest?.decision === "approve" ? "Voiding..." : "Declining..."}
          confirmDisabled={!validateVoidNote(decisionNote).ok}
          onConfirm={doDecide}
          onCancel={closeDecisionDialog}
        >
          <VoidNoteField
            value={decisionNote}
            onChange={setDecisionNote}
            error={decisionNoteError}
            onErrorChange={setDecisionNoteError}
            autoFocus
            label={decidingRequest?.decision === "approve" ? "Reason for void" : "Decline reason"}
          />
        </ConfirmDialog>
      </div>
    </PageErrorBoundary>
  );
}