import { useCallback, useEffect, useState } from "react";
import { CheckSquare, SlidersHorizontal, Square, Boxes, RefreshCw, Plus, PackagePlus } from "lucide-react";
import api from "../api.js";
import Badge from "../components/Badge.jsx";
import SensorPanel from "../components/SensorPanel.jsx";
import EmptyState from "../components/EmptyState.jsx";
import PageErrorBoundary from "../components/PageErrorBoundary.jsx";
import ConfirmDialog from "../components/ConfirmDialog.jsx";
import PageHeader from "../components/PageHeader.jsx";
import Select from "../components/Select.jsx";
import { useToast } from "../components/Toast.jsx";

const STATUS_LABEL = { ok: "OK", low: "LOW", critical: "CRITICAL" };

export default function InventoryPage() {
  const toast = useToast();
  const [locations, setLocations] = useState([]);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  
  // States para sa Adjusting Stock
  const [adjusting, setAdjusting] = useState(null);
  const [newStock, setNewStock] = useState("");
  const [adjustError, setAdjustError] = useState("");
  const [saving, setSaving] = useState(false);
  
  // States para sa Add New Item
  const [addOpen, setAddOpen] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [addError, setAddError] = useState("");
  const [newItem, setNewItem] = useState({
    name: "",
    category: "Ingredients",
    unit: "pcs",
    threshold: "",
    stock: ""
  });

  const [forecast, setForecast] = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkValue, setBulkValue] = useState("");
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [prep, setPrep] = useState(null);
  const [applyingId, setApplyingId] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  const refresh = useCallback(() => {
    const targetCode = selected || "CART-01";
    setLoading(true);
    
    Promise.all([
      api.get("/inventory"),
      api.get(`/analytics/forecast?code=${targetCode}`).catch(() => ({ data: { items: [] } })),
      api.get(`/reorders/prep?code=${targetCode}&days=3`).catch(() => ({ data: null })),
    ])
      .then(([inv, fc, pr]) => {
        setLocations(inv.data.locations);
        setForecast(fc.data?.items ?? []);
        setPrep(pr.data);
        
        if (!inv.data.locations.some((l) => l.code === selected) && inv.data.locations[0]) {
          setSelected(inv.data.locations[0].code);
        }
        setSelectedIds(new Set());
        setLastUpdated(new Date());
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
      setAdjustError("Enter a valid non-negative stock count.");
      return;
    }
    setAdjustError("");
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
      setAdjustError(err.response?.data?.error || "Adjustment failed - try again.");
    } finally {
      setSaving(false);
    }
  }

  // Function para i-save ang New Item
  async function handleAddItem(e) {
    e.preventDefault();
    setAddError("");
    setIsAdding(true);
    
    try {
      await api.post("/inventory/items", {
        locationCode: selected,
        name: newItem.name,
        category: newItem.category,
        unit: newItem.unit,
        threshold: Number(newItem.threshold),
        stock: Number(newItem.stock),
        source: "MANUAL"
      });
      
      toast(`${newItem.name} added successfully to ${selected}`, "success");
      setAddOpen(false);
      setNewItem({ name: "", category: "Ingredients", unit: "pcs", threshold: "", stock: "" });
      refresh();
    } catch (err) {
      setAddError(err.response?.data?.error || "Failed to add item. Backend endpoint may be missing.");
    } finally {
      setIsAdding(false);
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
  const locationOptions = locations.map((l) => ({ value: l.code, label: `${l.code} - ${l.name}` }));

  // Options para sa Custom Select
  const categoryOptions = [
    { value: "Ingredients", label: "Ingredients" },
    { value: "Packaging", label: "Packaging" },
    { value: "Cleaning", label: "Cleaning" },
    { value: "Others", label: "Others" },
  ];

  const unitOptions = [
    { value: "pcs", label: "Pieces (pcs)" },
    { value: "kg", label: "Kilograms (kg)" },
    { value: "g", label: "Grams (g)" },
    { value: "packs", label: "Packs" },
    { value: "liters", label: "Liters" },
    { value: "boxes", label: "Boxes" },
  ];

  return (
    <PageErrorBoundary>
      <div className="page-container wide inventory-page">
        <PageHeader
          eyebrow="Operations"
          title="Inventory"
          sub="Stock per cart - recount, forecast, and prep."
          actions={
            <>
              <span className="muted small" style={{ marginRight: "4px" }}>
                Last updated {lastUpdated?.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) ?? "just now"}
              </span>
              <button
                className="ghost small-btn"
                onClick={refresh}
                disabled={loading}
                title="Refresh inventory"
              >
                <RefreshCw size={14} className={loading ? "spin" : ""} /> Refresh
              </button>
            </>
          }
        />

        <section className="panel inventory-panel">
          <div className="inventory-filters-row">
            <Select
              value={selected}
              onChange={(val) => setSelected(val)}
              options={locationOptions}
              placeholder="Select a cart..."
            />
            {selected && (
              <button onClick={() => setAddOpen(true)}>
                <Plus size={16} /> Add Item
              </button>
            )}
          </div>

          {loading ? (
            <div className="table-wrap" tabIndex={0} aria-label="Loading table">
              <table className="data">
                <thead>
                  <tr>
                    <th style={{ width: 40 }}> </th>
                    <th><span className="th-inner">Item</span></th>
                    <th><span className="th-inner">Current stock</span></th>
                    <th><span className="th-inner">Threshold</span></th>
                    <th><span className="th-inner">Source</span></th>
                    <th><span className="th-inner">Status</span></th>
                    <th><span className="th-inner">Forecast</span></th>
                    <th className="t-center"><span className="th-inner">Action</span></th>
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i}>
                      <td><div className="skel" style={{ height: 14, width: 14, borderRadius: 4, display: "inline-block", margin: "4px 0" }} /></td>
                      <td><div className="skel" style={{ width: `${40 + (i * 17) % 30}%`, height: 14, display: "inline-block", margin: "4px 0" }} /></td>
                      <td><div className="skel" style={{ width: "60%", height: 14, display: "inline-block", margin: "4px 0" }} /></td>
                      <td><div className="skel" style={{ width: "60%", height: 14, display: "inline-block", margin: "4px 0" }} /></td>
                      <td><div className="skel" style={{ width: "80%", height: 14, display: "inline-block", margin: "4px 0" }} /></td>
                      <td><div className="skel" style={{ width: "80%", height: 14, display: "inline-block", margin: "4px 0" }} /></td>
                      <td><div className="skel" style={{ width: "90%", height: 14, display: "inline-block", margin: "4px 0" }} /></td>
                      <td className="t-center"><div className="skel" style={{ width: "80%", height: 14, display: "inline-block", margin: "4px 0" }} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
                    <th style={{ width: 40, paddingLeft: 12 }}>
                      <button
                        className={`table-checkbox ${allSelected ? "checked" : ""}`}
                        onClick={toggleSelectAll}
                        title={allSelected ? "Deselect all" : "Select all"}
                        aria-label={allSelected ? "Deselect all" : "Select all"}
                        aria-pressed={allSelected}
                      >
                        {allSelected ? <CheckSquare size={16} /> : <Square size={16} />}
                      </button>
                    </th>
                    <th><span className="th-inner">Item</span></th>
                    <th><span className="th-inner">Current stock</span></th>
                    <th><span className="th-inner">Threshold</span></th>
                    <th><span className="th-inner">Source</span></th>
                    <th><span className="th-inner">Status</span></th>
                    <th><span className="th-inner">Forecast</span></th>
                    <th className="t-center"><span className="th-inner">Action</span></th>
                  </tr>
                </thead>
                <tbody>
                  {current.items.map((item) => {
                    const fcItem = forecast.find((f) => f.name === item.name);
                    const isSelected = selectedIds.has(item.id);
                    return (
                      <tr key={item.id} className={isSelected ? "row-selected" : undefined}>
                        <td style={{ paddingLeft: 12 }}>
                          <button
                            className={`table-checkbox ${isSelected ? "checked" : ""}`}
                            onClick={() => toggleSelect(item.id)}
                            title={isSelected ? "Deselect" : "Select"}
                            aria-label={`${isSelected ? "Deselect" : "Select"} ${item.name}`}
                            aria-pressed={isSelected}
                          >
                            {isSelected ? <CheckSquare size={16} /> : <Square size={16} />}
                          </button>
                        </td>
                        <td><strong>{item.name}</strong></td>
                        <td className={item.status === "ok" ? "" : "stock-warn"}>
                          {item.stock} {item.unit}
                        </td>
                        <td className="muted">{item.threshold} {item.unit}</td>
                        <td>
                          <Badge variant={item.source === "SENSOR" ? "info" : "neutral"}>
                            {item.source}
                          </Badge>
                        </td>
                        <td><Badge variant={item.status}>{STATUS_LABEL[item.status]}</Badge></td>
                        <td>
                          {fcItem?.data_sufficient && fcItem.depletion_date ? (
                            <Badge
                              variant={fcItem.risk === "high" ? "danger" : fcItem.risk === "medium" ? "warn" : "ok"}
                              title={`Avg ${fcItem.avg_daily_use} ${item.unit}/day - MAPE ${fcItem.mape_pct}%`}
                            >
                              {fcItem.depletion_date}
                            </Badge>
                          ) : fcItem ? (
                            <Badge variant="neutral" title={fcItem.reason || "Not enough data yet"}>
                              -
                            </Badge>
                          ) : (
                            <span className="muted small">-</span>
                          )}
                        </td>
                        <td className="t-center">
                          <button
                            className="ghost small-btn"
                            onClick={() => {
                              setAdjusting(item);
                              setNewStock(String(item.stock));
                              setAdjustError("");
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

        {/* BULK ACTION BAR */}
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

        {/* PREP & REVIEW THRESHOLDS PANEL */}
        {prep && (
          <section className="panel" style={{ marginTop: "var(--space-3)" }}>
            <h3 className="section-title">Prep for the next {prep.days} days</h3>
            <p className="muted small">
              Expected usage from trailing averages scaled by weekday patterns.
              Shortfall = what to prepare beyond current stock.
            </p>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th><span className="th-inner">Item</span></th>
                    <th className="t-center"><span className="th-inner">Stock</span></th>
                    <th className="t-center"><span className="th-inner">Expected use</span></th>
                    <th className="t-center"><span className="th-inner">Shortfall</span></th>
                  </tr>
                </thead>
                <tbody>
                  {prep.prep.map((p) => (
                    <tr key={p.item}>
                      <td><strong>{p.item}</strong> <span className="muted small">{p.unit}</span></td>
                      <td className="t-center">{p.current_stock}</td>
                      <td className="t-center">{p.data_sufficient ? p.expected_use : <span className="muted">-</span>}</td>
                      <td className="t-center">
                        {p.data_sufficient ? (
                          p.shortfall > 0
                            ? <Badge variant="danger">PREP {p.shortfall}</Badge>
                            : <Badge variant="ok">COVERED</Badge>
                        ) : (
                          <span className="muted small">{p.reason}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            
            {prep.calibration.length > 0 && (
              <div style={{ marginTop: "var(--space-4)" }}>
                <h3 className="section-title">Threshold review</h3>
                <p className="muted small">
                  Noisy thresholds alert while stock stays healthy; silent ones
                  never fire. One click applies the suggestion.
                </p>
                {prep.calibration.map((c) => (
                  <div key={c.inventory_item_id} className="alert-item">
                    <span className="alert-item-text">
                      <div className="alert-item-name">
                        {c.item}{" "}
                        <Badge variant={c.verdict === "noisy" ? "warn" : "danger"}>
                          {c.verdict.toUpperCase()}
                        </Badge>
                      </div>
                      <div className="alert-item-detail">{c.reason}</div>
                    </span>
                    <span className="muted small">
                      {c.current_threshold} &rarr; <strong>{c.suggested_threshold}</strong>
                    </span>
                    <button
                      className="ghost small-btn"
                      disabled={applyingId === c.inventory_item_id}
                      onClick={async () => {
                        setApplyingId(c.inventory_item_id);
                        try {
                          await api.patch(
                            `/inventory/items/${c.inventory_item_id}`,
                            { threshold: c.suggested_threshold }
                          );
                          toast(`Threshold for ${c.item} set to ${c.suggested_threshold}`, "success");
                          refresh();
                        } catch (err) {
                          toast(err.response?.data?.error || "Update failed", "error");
                        } finally {
                          setApplyingId(null);
                        }
                      }}
                    >
                      {applyingId === c.inventory_item_id ? "Applying..." : "Apply"}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* SENSOR PANEL */}
        <div style={{ marginTop: "var(--space-3)" }}>
          <SensorPanel code={selected} />
        </div>

        {/* ADD NEW ITEM MODAL */}
        {addOpen && (
          <div className="modal-backdrop" onClick={() => setAddOpen(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h3><PackagePlus size={22} className="muted"/> Add New Item</h3>
              <p className="muted" style={{ marginBottom: "20px", lineHeight: "1.4" }}>
                Add a new supply or ingredient to <strong>{selected}</strong>'s inventory. Tracked manually.
              </p>
              
              <form onSubmit={handleAddItem} className="flex flex-col gap-4">
                <label className="field">
                  Item Name
                  <input
                    type="text"
                    required
                    placeholder="e.g. Cheese Powder"
                    value={newItem.name}
                    onChange={(e) => setNewItem({ ...newItem, name: e.target.value })}
                    autoFocus
                  />
                </label>
                
                {/* 1FR 1FR GRID LAYOUT */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}>
                  <label className="field">
                    Category
                    <Select
                      value={newItem.category}
                      onChange={(val) => setNewItem({ ...newItem, category: val })}
                      options={categoryOptions}
                    />
                  </label>
                  
                  <label className="field">
                    Unit
                    <Select
                      value={newItem.unit}
                      onChange={(val) => setNewItem({ ...newItem, unit: val })}
                      options={unitOptions}
                    />
                  </label>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}>
                  <label className="field">
                    Initial Stock
                    <input
                      type="number"
                      min="0"
                      step="any"
                      required
                      placeholder="e.g. 10"
                      value={newItem.stock}
                      onChange={(e) => setNewItem({ ...newItem, stock: e.target.value })}
                    />
                  </label>
                  
                  <label className="field">
                    Low Threshold
                    <input
                      type="number"
                      min="0"
                      step="any"
                      required
                      placeholder="e.g. 2"
                      value={newItem.threshold}
                      onChange={(e) => setNewItem({ ...newItem, threshold: e.target.value })}
                    />
                  </label>
                </div>
                
                <div className="modal-actions">
                  <button type="button" className="ghost" onClick={() => setAddOpen(false)}>Cancel</button>
                  <button type="submit" disabled={isAdding}>
                    {isAdding ? "Adding..." : "Add Item"}
                  </button>
                </div>
                {addError && <p className="error-box" role="alert" style={{ marginTop: "12px" }}>{addError}</p>}
              </form>
            </div>
          </div>
        )}

        {/* ADJUSTMENT MODAL */}
        {adjusting && (
          <div className="modal-backdrop" onClick={() => setAdjusting(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h3><SlidersHorizontal size={22} className="muted"/> Adjust stock</h3>
              <p className="muted" style={{ marginBottom: "20px", lineHeight: "1.4" }}>
                Manual recount after a physical check for <strong>{adjusting.name}</strong>. Current: {adjusting.stock}{" "}
                {adjusting.unit}. 
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
              {adjustError && <p className="error-box" role="alert" style={{ marginTop: "12px" }}>{adjustError}</p>}
            </div>
          </div>
        )}

        {/* BULK CONFIRM DIALOG */}
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