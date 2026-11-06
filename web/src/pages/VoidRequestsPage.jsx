import { useState, useEffect, useCallback } from "react";
import { useOutletContext } from "react-router-dom";
import { Hourglass, Check, Ban, RefreshCw, Square, CheckSquare } from "lucide-react";

import api from "../api.js";
import { getFriendlyError } from "../utils/errors.js";
import ConfirmDialog from "../components/ConfirmDialog.jsx";
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

  const load = useCallback(async () => {
    if (!isOwner) return;
    setLoading(true);
    setError("");
    try {
      const res = await api.get("/alerts?page=1&pageSize=100");
      const pending = (res.data?.data ?? []).filter(
        (a) => a.type === "VOID_REQUEST" && a.isRead !== true
      );
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

  async function decideOne(request, decision) {
    const orderId = orderIdOf(request);
    if (!orderId) {
      toast("This request has no order reference.", "error");
      return false;
    }
    setDeciding(request.id);
    try {
      await api.patch(`/orders/${orderId}/void-request`, { decision });
      toast(
        decision === "approve"
          ? `Order #${orderId} voided - stock restored`
          : `Order #${orderId} stays as paid`,
        "success"
      );
      return true;
    } catch (err) {
      toast(getFriendlyError(err, "Could not record the void decision."), "error");
      return false;
    } finally {
      setDeciding(null);
    }
  }

  async function runBulk(decision) {
    setBulkPending(true);
    const targets = voidRequests.filter((r) => selected.has(r.id));
    let okCount = 0;
    const failed = [];
    for (const req of targets) {
      const orderId = orderIdOf(req);
      if (!orderId) { failed.push(req); continue; }
      setDeciding(req.id);
      try {
        await api.patch(`/orders/${orderId}/void-request`, { decision });
        okCount++;
      } catch {
        failed.push(req);
      } finally {
        setDeciding(null);
      }
    }
    setBulkPending(false);
    setConfirmBulk(null);
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
          action={
            <button type="button" className="ghost small-btn" onClick={load} disabled={loading}>
              <RefreshCw size={13} aria-hidden="true" /> Refresh
            </button>
          }
        />

        {error ? (
          <ErrorBox message={error} onRetry={load} />
        ) : loading ? (
          <div className="panel" style={{ padding: "var(--space-5)" }}>
            <p className="muted small">Loading void requests...</p>
          </div>
        ) : voidRequests.length === 0 ? (
          <EmptyState
            icon={Check}
            title="No void requests waiting"
            subtitle="Approved and denied requests are cleared from this list automatically."
            compact
          />
        ) : (
          <>
            <div className="panel" style={{ marginBottom: "var(--space-4)", padding: "var(--space-3) var(--space-4)" }}>
              <div className="flex items-center justify-between gap-3" style={{ flexWrap: "wrap" }}>
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
                    onClick={() => setConfirmBulk("deny")}
                  >
                    <Ban size={13} aria-hidden="true" /> Deny selected
                  </button>
                  <button
                    type="button"
                    className="small-btn"
                    disabled={!someSelected || bulkPending}
                    onClick={() => setConfirmBulk("approve")}
                  >
                    <Check size={13} aria-hidden="true" /> Void selected
                  </button>
                </div>
              </div>
            </div>

            <div className="table-wrap settings-table-wrap">
              <table className="data table-fixed settings-table">
                <thead>
                  <tr>
                    <th style={{ width: "40px" }}></th>
                    <th>Order</th>
                    <th className="settings-hide-narrow">Requester</th>
                    <th className="settings-hide-narrow">Reason</th>
                    <th className="settings-hide-narrow">Requested</th>
                    <th className="t-center">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {voidRequests.map((req) => {
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
                        <td><strong>#{orderId ?? "?"}</strong></td>
                        <td className="settings-hide-narrow">{req.requestedByName || "Staff"}</td>
                        <td className="settings-hide-narrow small muted">
                          {req.reason || "—"}
                        </td>
                        <td className="settings-hide-narrow small muted">
                          {req.createdAt ? new Date(req.createdAt).toLocaleString() : "—"}
                        </td>
                        <td className="t-center settings-actions-cell">
                          <div className="settings-table-actions">
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
          </>
        )}

        <ConfirmDialog
          open={Boolean(confirmBulk)}
          title={confirmBulk === "approve" ? "Void selected orders?" : "Deny selected requests?"}
          message={
            confirmBulk === "approve"
              ? `${selected.size} order(s) will be voided and stock restored for each.`
              : `${selected.size} request(s) will be denied; those orders stay as paid.`
          }
          confirmLabel={confirmBulk === "approve" ? "Void selected" : "Deny selected"}
          danger={confirmBulk === "deny"}
          pending={bulkPending}
          pendingLabel="Working..."
          onConfirm={() => runBulk(confirmBulk)}
          onCancel={() => setConfirmBulk(null)}
        />
      </div>
    </PageErrorBoundary>
  );
}