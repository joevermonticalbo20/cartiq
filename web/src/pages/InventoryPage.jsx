import { useCallback, useEffect, useState } from "react";
import { CheckSquare, SlidersHorizontal, Square, Boxes } from "lucide-react";
import api from "../api.js";
import SensorPanel from "../components/SensorPanel.jsx";
import EmptyState from "../components/EmptyState.jsx";
import PageErrorBoundary from "../components/PageErrorBoundary.jsx";
import ConfirmDialog from "../components/ConfirmDialog.jsx";
import { useToast } from "../components/Toast.jsx";

const STATUS_LABEL = { ok: "OK", low: "LOW", critical: "CRITICAL" };

export default function InventoryPage() {
  const toast = useToast();
  const [locations, setLocations] = useState([]);
  const [selected, setSelected] = useState("CART-01");
  const [loading, setLoading] = useState(true);
  const [adjusting, setAdjusting] = useState(null);
  const [newStock, setNewStock] = useState("");
  const [saving, setSaving] = useState(false);
  const [forecast, setForecast] = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkValue, setBulkValue] = useState("");
  const [bulkConfirm, setBulkConfirm] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.get("/inventory"),
      api.get(`/analytics/forecast?code=${selected}`).catch(() => ({ data: { items: [] } })),
    ])
      .then(([inv, fc]) => {
        setLocations(inv.data.locations);
        setForecast(fc.data?.items ?? []);
        if (!inv.data.locations.some((l) => l.code === selected) && inv.data.locations[0]) {
          setSelected(inv.data.locations[0].code);
        }
        setSelectedIds(new Set());
      })
      .finally(() => setLoading(false));
  }, [selected]);

  useEffect(() => {
    const timer = setTimeout(refresh, 0);
    return () => clearTimeout(timer);
  }, [refresh]);

  async function saveAdjustment() {
    if (!adjusting) return;
    const value = Number(newStock);
    if (!Number.isFinite(value) || value < 0) {
      toast("Enter a valid non-negative stock count", "error");
      return;
    }
    setSaving(true);
    try {
      await api.post("/inventory/adjustments", {
        inventoryItemId: adjusting.id,
        newStock: value,
        reason: "manual recount via dashboard",
      });
      toast(`${adjusting.name} updated to ${value} ${adjusting.unit}`, "success");
      setAdjusting(null);
      refresh();
    } catch (err) {
      toast(err.response?.data?.error || "Adjustment failed", "error");
    } finally {
      setSaving(false);
    }
  }

  function toggleSelect(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (!current) return;
    if (selectedIds.size === current.items.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(current.items.map((it) => it.id)));
    }
  }

  async function commitBulk() {
    const value = Number(bulkValue);
    if (!Number.isFinite(value) || value < 0) {
      toast("Enter a valid non-negative stock count", "error");
      return;
    }
    if (selectedIds.size === 0) return;
    setSaving(true);
    let success = 0;
    let failed = 0;
    for (const id of selectedIds) {
      try {
        await api.post("/inventory/adjustments", {
          inventoryItemId: id,
          newStock: value,
          reason: "bulk recount via dashboard",
        });
        success++;
      } catch {
        failed++;
      }
    }
    if (success > 0) {
      toast(`Bulk updated ${success} item(s) to ${value}`, "success");
    }
    if (failed > 0) {
      toast(`${failed} item(s) failed to update`, "error");
    }
    setBulkConfirm(false);
    setBulkValue("");
    setSaving(false);
    refresh();
  }

  const current = locations.find((l) => l.code === selected);
  const allSelected = current && selectedIds.size === current.items.length && current.items.length > 0;

  return (
    <PageErrorBoundary>
    <div className="page-container">
      <section className="panel">
        <div className="panel-head">
          <h3>Inventory by cart</h3>
          <select
            className="cart-select"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            {locations.map((l) => (
              <option key={l.id} value={l.code}>{l.code} - {l.name}</option>
            ))}
          </select>
        </div>

        {loading ? (
          <div className="skel" style={{ width: "60%" }} />
        ) : !current ? (
          <EmptyState
            icon={Boxes}
            title="No carts configured"
            subtitle="Add a cart from the catalog to start tracking inventory and sensor readings."
          />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>
                    <button
                      className="icon-only ghost small-btn"
                      onClick={toggleSelectAll}
                      title={allSelected ? "Deselect all" : "Select all"}
                    >
                      {allSelected ? <CheckSquare size={14} /> : <Square size={14} />}
                    </button>
                  </th>
                  <th>Item</th>
                  <th>Current stock</th>
                  <th>Threshold</th>
                  <th>Source</th>
                  <th>Status</th>
                  <th>Forecast</th>
                  <th className="t-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {current.items.map((item) => {
                  const fcItem = forecast.find((f) => f.name === item.name);
                  const isSelected = selectedIds.has(item.id);
                  return (
                  <tr key={item.id} className={isSelected ? "row-selected" : undefined}>
                    <td>
                      <button
                        className="icon-only ghost small-btn"
                        onClick={() => toggleSelect(item.id)}
                        title={isSelected ? "Deselect" : "Select"}
                      >
                        {isSelected ? <CheckSquare size={14} color="var(--primary)" /> : <Square size={14} />}
                      </button>
                    </td>
                    <td><strong>{item.name}</strong></td>
                    <td className={item.status === "ok" ? "" : "stock-warn"}>
                      {item.stock} {item.unit}
                    </td>
                    <td className="muted">{item.threshold} {item.unit}</td>
                    <td>
                      <span className={`chip ${item.source === "SENSOR" ? "loc" : "read"}`}>
                        {item.source}
                      </span>
                    </td>
                    <td><span className={`chip ${item.status}`}>{STATUS_LABEL[item.status]}</span></td>
                    <td>
                      {fcItem?.data_sufficient && fcItem.depletion_date ? (
                        <span
                          className={`chip ${fcItem.risk === "high" ? "critical" : fcItem.risk === "medium" ? "low" : "ok"}`}
                          title={`Avg ${fcItem.avg_daily_use} ${item.unit}/day · MAPE ${fcItem.mape_pct}%`}
                        >
                          {fcItem.depletion_date}
                        </span>
                      ) : fcItem ? (
                        <span className="chip read" title={fcItem.reason || "Not enough data yet"}>
                          —
                        </span>
                      ) : (
                        <span className="muted small">—</span>
                      )}
                    </td>
                    <td className="t-right">
                      <button
                        className="ghost small-btn"
                        onClick={() => {
                          setAdjusting(item);
                          setNewStock(String(item.stock));
                        }}
                      >
                        <SlidersHorizontal size={13} /> Adjust
                      </button>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selectedIds.size > 0 && (
        <div className="bulk-action-bar" role="region" aria-live="polite">
          <span>
            <strong>{selectedIds.size}</strong> item(s) selected
          </span>
          <input
            type="number"
            min="0"
            step="any"
            placeholder="New stock value"
            value={bulkValue}
            onChange={(e) => setBulkValue(e.target.value)}
            className="bulk-input"
            aria-label="New stock value for selected items"
          />
          <button
            onClick={() => setBulkConfirm(true)}
            disabled={saving || !bulkValue || !Number.isFinite(Number(bulkValue))}
            aria-label={`Apply new stock value to ${selectedIds.size} items`}
          >
            Apply to {selectedIds.size}
          </button>
          <button
            className="ghost"
            onClick={() => setSelectedIds(new Set())}
            aria-label="Clear selection"
          >
            Clear
          </button>
        </div>
      )}

      <div style={{ marginTop: "var(--space-3)" }}>
        <SensorPanel code={selected} />
      </div>

      {adjusting && (
        <div className="modal-backdrop" onClick={() => setAdjusting(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Adjust stock - {adjusting.name}</h3>
            <p className="muted small">
              Manual recount after a physical check. Current: {adjusting.stock}{" "}
              {adjusting.unit}. Sensor items will be overwritten by the next reading.
            </p>
            <label className="field">
              New stock count ({adjusting.unit})
              <input
                type="number"
                min="0"
                step="any"
                value={newStock}
                onChange={(e) => setNewStock(e.target.value)}
                autoFocus
              />
            </label>
            <div className="modal-actions">
              <button className="ghost" onClick={() => setAdjusting(null)}>Cancel</button>
              <button disabled={saving} onClick={saveAdjustment}>
                {saving ? "Saving..." : "Save adjustment"}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={bulkConfirm}
        title="Bulk stock adjustment"
        message={`Set ${selectedIds.size} selected item(s) to ${bulkValue} units. Sensor-tracked items will be overwritten by the next reading. This action cannot be undone.`}
        confirmLabel={`Update ${selectedIds.size} item(s)`}
        onConfirm={commitBulk}
        onCancel={() => setBulkConfirm(false)}
      />
    </div>
    </PageErrorBoundary>
  );
}
