import { useCallback, useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { CheckSquare, SlidersHorizontal, Square, Boxes, RefreshCw, Plus, PackagePlus, Edit2, Trash2 } from "lucide-react";

import api from "../api.js";
import { getFriendlyError } from "../utils/errors.js";
import Badge from "../components/Badge.jsx";
import SensorPanel from "../components/SensorPanel.jsx";
import EmptyState from "../components/EmptyState.jsx";
import ErrorBox from "../components/ErrorBox.jsx";
import PageErrorBoundary from "../components/PageErrorBoundary.jsx";
import ConfirmDialog from "../components/ConfirmDialog.jsx";
import PageHeader from "../components/PageHeader.jsx";
import Select from "../components/Select.jsx";
import { useToast } from "../components/Toast.jsx";
import Skeleton from "../components/Skeleton.jsx";
import { sanitizeQtyInput, parseQty } from "../utils/format.js";
import { sanitizeTextInput, validateItemName } from "../utils/text.js";

const STATUS_LABEL = { ok: "OK", low: "LOW", critical: "CRITICAL" };

export default function InventoryPage() {
  const toast = useToast();
  const { user } = useOutletContext();
  const isOwner = user?.role === "OWNER";

  const [locations, setLocations] = useState([]);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [adjusting, setAdjusting] = useState(null);
  const [adjustClosing, setAdjustClosing] = useState(false);
  const [newStock, setNewStock] = useState("");
  const [adjustError, setAdjustError] = useState("");
  const [saving, setSaving] = useState(false);

  const [addOpen, setAddOpen] = useState(false);
  const [addClosing, setAddClosing] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [addError, setAddError] = useState("");
  const [newItem, setNewItem] = useState({
    name: "",
    category: "Ingredients",
    unit: "pcs",
    threshold: "",
    stock: ""
  });

  // --- NEW STATES FOR EDIT & DELETE ---
  const [editing, setEditing] = useState(null);
  const [editClosing, setEditClosing] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editError, setEditError] = useState("");
  
  const [deleting, setDeleting] = useState(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const [forecast, setForecast] = useState(null);
  const [loadError, setLoadError] = useState("");

  // Stock item name -> ["Product (Flavor)", ...] (from /products recipes).
  const [usageByItem, setUsageByItem] = useState(new Map());
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkValue, setBulkValue] = useState("");
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [prep, setPrep] = useState(null);
  const [applyingId, setApplyingId] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  function closeAddModal() {
    setAddClosing(true);
    setTimeout(() => { setAddOpen(false); setAddClosing(false); }, 150);
  }

  function closeAdjustModal() {
    setAdjustClosing(true);
    setTimeout(() => { setAdjusting(null); setAdjustClosing(false); }, 150);
  }

  function closeEditModal() {
    setEditClosing(true);
    setTimeout(() => { setEditing(null); setEditClosing(false); }, 150);
  }

  // UX Fix: Added editing, editClosing, and deleting to global scroll lock
  const isAnyModalOpen = addOpen || addClosing || adjusting || adjustClosing || bulkConfirm || editing || editClosing || Boolean(deleting);
  useEffect(() => {
    if (isAnyModalOpen) document.body.style.overflow = "hidden";
    else document.body.style.overflow = "";
    return () => { document.body.style.overflow = ""; };
  }, [isAnyModalOpen]);

  const refresh = useCallback(() => {
    const targetCode = selected || "CART-01";
    setLoading(true);
    Promise.all([
      api.get("/inventory"),
      api.get(`/analytics/forecast?code=${targetCode}`).catch(() => ({ data: { items: [] } })),
      api.get(`/reorders/prep?code=${targetCode}&days=3`).catch(() => ({ data: null })),
      api.get("/products").catch(() => ({ data: { data: [] } })),
    ])
      .then(([inv, fc, pr, prod]) => {
        const locs = inv.data?.locations ?? [];
        setLocations(locs);
        setForecast(fc.data?.items ?? []);
        setPrep(pr.data);

        // Reverse map: stock item name -> ["Product (Flavor)", ...] so each
        // row shows what consumes it (same recipe rows the POS deducts).
        const usage = new Map();
        for (const p of prod.data?.data ?? []) {
          for (const f of p.flavors ?? []) {
            for (const r of f.recipes ?? []) {
              const name = String(r.itemName ?? "").trim();
              if (!name) continue;
              if (!usage.has(name)) usage.set(name, []);
              const label = `${p.name}${f.name ? ` (${f.name})` : ""}`;
              if (!usage.get(name).includes(label)) usage.get(name).push(label);
            }
          }
        }
        setUsageByItem(usage);
        setLoadError("");
        if (!locs.some((l) => l.code === selected) && locs[0]) {
          setSelected(locs[0].code);
        }
        setSelectedIds(new Set());
        setLastUpdated(new Date());
      })
      .catch((err) => setLoadError(getFriendlyError(err, "Unable to load inventory.")))
      .finally(() => setLoading(false));
  }, [selected]);

  useEffect(() => {
    const timer = setTimeout(refresh, 0);
    return () => clearTimeout(timer);
  }, [refresh]);

  async function saveAdjustment() {
    if (!adjusting) return;
    const value = parseQty(newStock);
    if (value === null) {
      setAdjustError("Enter a stock count from 0 to 99,999.99 (whole units max 5 digits, up to 2 decimals).");
      return;
    }
    if (value === adjusting.stock) {
      toast(`No changes - ${adjusting.name} is already ${adjusting.stock} ${adjusting.unit}.`, "info");
      closeAdjustModal();
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
      closeAdjustModal();
      refresh();
    } catch (err) {
      setAdjustError(getFriendlyError(err, "Adjustment failed - try again."));
    } finally {
      setSaving(false);
    }
  }

  async function handleAddItem(e) {
    e.preventDefault();
    setAddError("");

    const name = validateItemName(newItem.name);
    if (!name.ok) {
      setAddError(name.error);
      return;
    }

    const stock = parseQty(newItem.stock);
    const threshold = parseQty(newItem.threshold);

    if (stock === null || threshold === null) {
      setAddError("Stock and threshold must be 0 to 99,999.99 (whole units max 5 digits, up to 2 decimals).");
      return;
    }

    setIsAdding(true);
    
    try {
      await api.post("/inventory/items", {
        locationCode: selected,
        name: name.value,
        category: newItem.category,
        unit: newItem.unit,
        threshold,
        stock,
        source: "MANUAL"
      });
      
      toast(`${name.value} added successfully to ${selected}`, "success");
      closeAddModal();
      setNewItem({ name: "", category: "Ingredients", unit: "pcs", threshold: "", stock: "" });
      refresh();
    } catch (err) {
      setAddError(getFriendlyError(err, "Failed to add item. Backend endpoint may be missing."));
    } finally {
      setIsAdding(false);
    }
  }

  // --- NEW HANDLERS FOR EDIT & DELETE ---
  // Note: the API applies threshold only (name/category/unit have no backing
  // fields), so the edit form is threshold-only and no-change is measured on it.
  async function handleEditItem(e) {
    e.preventDefault();
    setEditError("");

    const nextThreshold = parseQty(editing.threshold);
    if (nextThreshold === null) {
      setEditError("Enter a threshold from 0 to 99,999.99 (whole units max 5 digits, up to 2 decimals).");
      return;
    }

    const original = currentItems.find((it) => it.id === editing.id);
    if (original && nextThreshold === original.threshold) {
      toast(`No changes - threshold is already ${original.threshold}.`, "info");
      closeEditModal();
      return;
    }

    setIsEditing(true);
    try {
      await api.patch(`/inventory/items/${editing.id}`, {
        threshold: nextThreshold
      });
      
      toast(`Threshold updated to ${nextThreshold}`, "success");
      closeEditModal();
      refresh();
    } catch (err) {
      setEditError(getFriendlyError(err, "Failed to update item."));
    } finally {
      setIsEditing(false);
    }
  }

  async function handleDeleteItem() {
    if (!deleting) return;
    setIsDeleting(true);
    try {
      await api.del(`/inventory/items/${deleting.id}`);
      toast(`${deleting.name} deleted successfully`, "success");
      setDeleting(null);
      refresh();
    } catch (err) {
      toast(getFriendlyError(err, "Failed to delete item."), "error");
    } finally {
      setIsDeleting(false);
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
    if (selectedIds.size === currentItems.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(currentItems.map((it) => it.id)));
    }
  }

  async function commitBulk() {
    if (saving) return;
    const value = parseQty(bulkValue);
    if (value === null) {
      toast("Enter a stock count from 0 to 99,999.99 (whole units max 5 digits, up to 2 decimals).", "error");
      return;
    }
    if (selectedIds.size === 0) return;

    setSaving(true);
    const byId = new Map(currentItems.map((it) => [it.id, it]));
    let skipped = 0;
    let success = 0;
    let failed = 0;

    for (const id of selectedIds) {
      if (byId.get(id)?.stock === value) {
        skipped++;
        continue;
      }
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

    if (success === 0 && failed === 0 && skipped > 0) {
      toast(`No changes - ${skipped} item(s) already at ${value}.`, "info");
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

  const safeLocations = Array.isArray(locations) ? locations : [];
  const safeForecast = Array.isArray(forecast) ? forecast : [];
  const current = safeLocations.find((l) => l.code === selected);
  const currentItems = current?.items ?? [];
  const allSelected = current && selectedIds.size === currentItems.length && currentItems.length > 0;

  const locationOptions = safeLocations.map((l) => ({ value: l.code, label: `${l.code} - ${l.name}` }));
  
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
            <>
              <p role="status" className="muted small" style={{ margin: "0 0 var(--space-2)" }}>
                Loading inventory
              </p>
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
                    <tr>
                      <td colSpan="8" style={{ padding: "var(--space-4)" }}>
                        <Skeleton rows={5} height={44} />
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </>
          ) : loadError ? (
            <ErrorBox message={loadError} onRetry={refresh} />
          ) : !current ? (
            <EmptyState
              icon={Boxes}
              title="No carts configured"
              subtitle="Add a cart from the catalog to start tracking inventory and sensor readings."
            />
          ) : currentItems.length === 0 ? (
            <EmptyState
              icon={Boxes}
              title="No inventory items"
              subtitle={`Add items to ${selected} to start tracking stock.`}
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
                    <th className="t-center" style={{ width: 140 }}><span className="th-inner">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {currentItems.map((item) => {
                    const fcItem = safeForecast.find((f) => f.name === item.name);
                    const isSelected = selectedIds.has(item.id);
                    const usedBy = usageByItem.get(item.name) ?? [];

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
                        <td>
                          <strong>{item.name}</strong>
                          {usedBy.length > 0 && (
                            <span
                              className="muted small"
                              style={{ display: "block" }}
                              title={`Deducted when selling: ${usedBy.join(", ")}`}
                            >
                              Used by {usedBy.slice(0, 2).join(", ")}
                              {usedBy.length > 2 ? ` +${usedBy.length - 2}` : ""}
                            </span>
                          )}
                        </td>
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
                        
                        {/* UPDATE: Added Edit & Delete actions */}
                        <td className="t-center nowrap">
                          <div className="flex items-center justify-center gap-1">
                            <button
                              className="ghost small-btn"
                              onClick={() => {
                                setAdjusting(item);
                                setNewStock(String(item.stock));
                                setAdjustError("");
                              }}
                              title="Adjust Stock"
                            >
                              <SlidersHorizontal size={13} />
                            </button>
                            <button
                              className="ghost small-btn"
                              onClick={() => {
                                setEditing({...item});
                                setEditError("");
                              }}
                              title="Edit Item"
                            >
                              <Edit2 size={13} />
                            </button>
                            <button
                              className="danger-ghost small-btn"
                              onClick={() => setDeleting(item)}
                              title="Delete Item"
                            >
                              <Trash2 size={13} />
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
        </section>

        {selectedIds.size > 0 && (
          <div className="bulk-action-bar" role="region" aria-live="polite">
            <span>
              <strong>{selectedIds.size}</strong> item(s) selected
            </span>
            <input
              type="number"
              min="0"
              max="99999.99"
              step="0.01"
              placeholder="New stock value"
              title="Max 5 whole digits, up to 2 decimals"
              value={bulkValue}
              onChange={(e) => setBulkValue(sanitizeQtyInput(e.target.value))}
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
                  {(prep.prep ?? []).map((p) => (
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
            
            {isOwner && (prep.calibration ?? []).length > 0 && (
              <div style={{ marginTop: "var(--space-4)" }}>
                <h3 className="section-title">Threshold review (owner)</h3>
                <p className="muted small">
                  Noisy thresholds alert while stock stays healthy; silent ones
                  never fire. One click applies the suggestion.
                </p>
                {(prep.calibration ?? []).map((c) => (
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
                          toast(getFriendlyError(err, "Update failed"), "error");
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

        <div style={{ marginTop: "var(--space-3)" }}>
          <SensorPanel code={selected} />
        </div>

        {/* MODALS */}
        
        {/* ADD ITEM MODAL */}
        {(addOpen || addClosing) && (
          <div className={`modal-backdrop ${addClosing ? "is-closing" : ""}`}>
            <div className={`modal ${addClosing ? "is-closing" : ""}`} onClick={(e) => e.stopPropagation()}>
              <h3><PackagePlus size={22} className="muted"/> Add New Item</h3>
              <p className="muted" style={{ marginBottom: "20px", lineHeight: "1.4" }}>
                Add a new supply or ingredient to <strong>{selected}</strong>&rsquo;s inventory. Tracked manually.
              </p>
              
              <form onSubmit={handleAddItem} className="flex flex-col gap-4">
                <label className="field">
                  Item Name
                  <input
                    type="text"
                    required
                    minLength={2}
                    maxLength={30}
                    placeholder="e.g. Cheese Powder"
                    title="Min 2 letters, max 30 characters, single spaces only"
                    value={newItem.name}
                    onChange={(e) => setNewItem({ ...newItem, name: sanitizeTextInput(e.target.value, 30) })}
                    autoFocus
                  />
                </label>
                
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
                      max="99999.99"
                      step="0.01"
                      required
                      placeholder="e.g. 10"
                      title="Max 5 whole digits, up to 2 decimals"
                      value={newItem.stock}
                      onChange={(e) => setNewItem({ ...newItem, stock: sanitizeQtyInput(e.target.value) })}
                    />
                  </label>
                  
                  <label className="field">
                    Low Threshold
                    <input
                      type="number"
                      min="0"
                      max="99999.99"
                      step="0.01"
                      required
                      placeholder="e.g. 2"
                      title="Max 5 whole digits, up to 2 decimals"
                      value={newItem.threshold}
                      onChange={(e) => setNewItem({ ...newItem, threshold: sanitizeQtyInput(e.target.value) })}
                    />
                  </label>
                </div>
                
                <div className="modal-actions">
                  <button type="button" className="ghost" onClick={closeAddModal} disabled={isAdding || addClosing}>Cancel</button>
                  <button type="submit" disabled={isAdding || addClosing}>
                    {isAdding ? "Adding..." : "Add Item"}
                  </button>
                </div>

                {addError && <p className="error-box" role="alert" style={{ marginTop: "12px" }}>{addError}</p>}
              </form>
            </div>
          </div>
        )}

        {/* EDIT ITEM MODAL */}
        {(editing || editClosing) && (
          <div className={`modal-backdrop ${editClosing ? "is-closing" : ""}`}>
            <div className={`modal ${editClosing ? "is-closing" : ""}`} onClick={(e) => e.stopPropagation()}>
              <h3><Edit2 size={22} className="muted"/> Edit Threshold</h3>
              <p className="muted" style={{ marginBottom: "20px", lineHeight: "1.4" }}>
                Low-stock threshold for <strong>{editing?.name}</strong> ({editing?.unit}). Stock counts are changed with the Adjust tool.
              </p>
              
              <form onSubmit={handleEditItem} className="flex flex-col gap-4">
                <label className="field">
                  Low Threshold
                  <input
                    type="number"
                    min="0"
                    max="99999.99"
                    step="0.01"
                    required
                    autoFocus
                    title="Max 5 whole digits, up to 2 decimals"
                    value={editing?.threshold ?? ""}
                    onChange={(e) => setEditing({ ...editing, threshold: sanitizeQtyInput(e.target.value) })}
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

        {/* ADJUST STOCK MODAL */}
        {(adjusting || adjustClosing) && (
          <div className={`modal-backdrop ${adjustClosing ? "is-closing" : ""}`}>
            <div className={`modal ${adjustClosing ? "is-closing" : ""}`} onClick={(e) => e.stopPropagation()}>
              <h3><SlidersHorizontal size={22} className="muted"/> Adjust stock</h3>
              <p className="muted" style={{ marginBottom: "20px", lineHeight: "1.4" }}>
                Manual recount after a physical check for <strong>{adjusting?.name}</strong>. Current: {adjusting?.stock}{" "}
                {adjusting?.unit}. 
              </p>
              <label className="field">
                New stock count ({adjusting?.unit})
                <input
                  type="number"
                  min="0"
                  max="99999.99"
                  step="0.01"
                  title="Max 5 whole digits, up to 2 decimals"
                  value={newStock}
                  onChange={(e) => setNewStock(sanitizeQtyInput(e.target.value))}
                  autoFocus
                />
              </label>

              <div className="modal-actions">
                <button className="ghost" onClick={closeAdjustModal} disabled={saving || adjustClosing}>Cancel</button>
                <button disabled={saving || adjustClosing} onClick={saveAdjustment}>
                  {saving ? "Saving..." : "Save adjustment"}
                </button>
              </div>
              {adjustError && <p className="error-box" role="alert" style={{ marginTop: "12px" }}>{adjustError}</p>}
            </div>
          </div>
        )}

        {/* BULK ADJUST CONFIRMATION */}
        <ConfirmDialog
          open={bulkConfirm}
          title="Bulk stock adjustment"
          message={`Set ${selectedIds.size} selected item(s) to ${bulkValue} units. Sensor-tracked items will be overwritten by the next reading. This action cannot be undone.`}
          confirmLabel={`Update ${selectedIds.size} item(s)`}
          pending={saving}
          pendingLabel="Updating..."
          onConfirm={commitBulk}
          onCancel={() => setBulkConfirm(false)}
        />

        {/* DELETE ITEM CONFIRMATION */}
        <ConfirmDialog
          open={Boolean(deleting)}
          title="Delete Item?"
          message={`Are you sure you want to permanently remove "${deleting?.name}" from this cart's inventory? This action cannot be undone.`}
          confirmLabel="Delete Item"
          danger={true}
          pending={isDeleting}
          pendingLabel="Deleting..."
          onConfirm={handleDeleteItem}
          onCancel={() => setDeleting(null)}
        />
      </div>
    </PageErrorBoundary>
  );
}