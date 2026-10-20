import { useCallback, useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { Plus, Edit2, Trash2, RefreshCw, Tag, AlertTriangle, Archive, ArchiveRestore } from "lucide-react";
import api from "../api.js";
import { getFriendlyError } from "../utils/errors.js";
import Badge from "../components/Badge.jsx";
import DataTable from "../components/DataTable.jsx";
import EmptyState from "../components/EmptyState.jsx";
import ErrorBox from "../components/ErrorBox.jsx";
import ConfirmDialog from "../components/ConfirmDialog.jsx";
import PageErrorBoundary from "../components/PageErrorBoundary.jsx";
import PageHeader from "../components/PageHeader.jsx";
import Select from "../components/Select.jsx";
import { useToast } from "../components/Toast.jsx";
import { sanitizeMoneyInput, sanitizeQtyInput, parseMoney, parseQty } from "../utils/format.js";
import { sanitizeTextInput, validateItemName } from "../utils/text.js";

let flavorRowSeq = 1;
function newFlavorRowState(overrides = {}) {
  return {
    key: `fr-${Date.now()}-${flavorRowSeq++}`,
    flavorId: null,
    unitPrice: "",
    recipes: [],
    collapsed: false,
    ...overrides,
  };
}

function newRecipeRowState(overrides = {}) {
  return {
    key: `rr-${Date.now()}-${flavorRowSeq++}`,
    itemName: "",
    amount: "",
    unit: "",
    ...overrides,
  };
}

const MASS_TO_KG = { g: 0.001, kg: 1 };

function unitOptionsFor(stockUnit) {
  const u = String(stockUnit ?? "").trim().toLowerCase();
  if (MASS_TO_KG[u] !== undefined) return ["g", "kg"];
  if (u) return [u];
  return ["pcs", "g", "kg", "packs"];
}

function defaultUnitFor(stockUnit) {
  const u = String(stockUnit ?? "").trim().toLowerCase();
  if (MASS_TO_KG[u] !== undefined) return "g";
  return u || "pcs";
}

function toStockUnit(displayAmount, displayUnit, stockUnit) {
  const from = String(displayUnit ?? "").trim().toLowerCase();
  const to = String(stockUnit ?? "").trim().toLowerCase();
  if (!from || !to) return { ok: true, value: displayAmount };
  if (from === to) return { ok: true, value: displayAmount };
  if (MASS_TO_KG[from] !== undefined && MASS_TO_KG[to] !== undefined) {
    return { ok: true, value: Math.round((displayAmount * MASS_TO_KG[from]) / MASS_TO_KG[to] * 1e6) / 1e6 };
  }
  return { ok: false };
}

export default function ProductsPage() {
  const toast = useToast();
  const { user } = useOutletContext();
  const isOwner = user?.role === "OWNER";

  const [products, setProducts] = useState([]);
  const [flavors, setFlavors] = useState([]);
  const [itemNames, setItemNames] = useState([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [addOpen, setAddOpen] = useState(false);
  const [addClosing, setAddClosing] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [addError, setAddError] = useState("");
  const [newProduct, setNewProduct] = useState({ name: "", category: "Fries", basePrice: "", markupPrice: "", sellingPrice: "" });
  
  const [addFlavorRows, setAddFlavorRows] = useState([]);
  const [addRowErrors, setAddRowErrors] = useState({});

  const setAddRows = (updater) => {
    setAddFlavorRows(updater);
    setAddRowErrors({});
  };

  const [editing, setEditing] = useState(null);
  const [editClosing, setEditClosing] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editError, setEditError] = useState("");

  const [renaming, setRenaming] = useState(null);
  const [renameClosing, setRenameClosing] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameError, setRenameError] = useState("");
  const [renameName, setRenameName] = useState("");

  const [deleting, setDeleting] = useState(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const [archiving, setArchiving] = useState(null);
  const [isArchiving, setIsArchiving] = useState(false);

  const [flavorDraft, setFlavorDraft] = useState("");
  const [flavorError, setFlavorError] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([api.get("/products"), api.get("/flavors"), api.get("/inventory/names").catch(() => ({ data: { data: [] } }))])
      .then(([p, f, n]) => {
        setProducts(p.data?.data ?? []);
        setFlavors(f.data?.data ?? []);
        setItemNames(n.data?.data ?? []);
        setError("");
      })
      .catch((err) => setError(getFriendlyError(err, "Unable to load products.")))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const timer = setTimeout(load, 0);
    return () => clearTimeout(timer);
  }, [load]);

  const isAnyModalOpen = addOpen || addClosing || editing || editClosing ||
    renaming || renameClosing || Boolean(deleting);

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

  function closeRenameModal() {
    setRenameClosing(true);
    setTimeout(() => { setRenaming(null); setRenameClosing(false); setRenameName(""); }, 150);
  }

  // --- AUTO-COMPUTE HANDLERS FOR PRICING ---
  const handleAddPriceChange = (field, val) => {
    setNewProduct(prev => {
      const next = { ...prev, [field]: val };
      const bp = parseFloat(next.basePrice || 0);
      
      if (field === 'basePrice' || field === 'markupPrice') {
        const mp = parseFloat(next.markupPrice || 0);
        next.sellingPrice = (bp + mp) > 0 ? (bp + mp).toFixed(2) : "";
      } else if (field === 'sellingPrice') {
        const sp = parseFloat(next.sellingPrice || 0);
        next.markupPrice = sp - bp >= 0 ? (sp - bp).toFixed(2) : "";
      }
      return next;
    });
  };

  const handleEditPriceChange = (field, val) => {
    setEditing(prev => {
      const next = { ...prev, [field]: val };
      const bp = parseFloat(next.basePrice || 0);
      
      if (field === 'basePrice' || field === 'markupPrice') {
        const mp = parseFloat(next.markupPrice || 0);
        next.sellingPrice = (bp + mp) > 0 ? (bp + mp).toFixed(2) : "";
      } else if (field === 'sellingPrice') {
        const sp = parseFloat(next.sellingPrice || 0);
        next.markupPrice = sp - bp >= 0 ? (sp - bp).toFixed(2) : "";
      }
      return next;
    });
  };

  async function createFlavorInlineForRows(setRows) {
    const name = sanitizeTextInput(flavorDraft, 60).trim();
    if (!name) {
      setFlavorError("Type a flavor name first.");
      return;
    }
    const dupe = flavors.some((f) => f.name.toLowerCase() === name.toLowerCase());
    if (dupe) {
      setFlavorError(`Flavor "${name}" already exists — pick it from the list.`);
      return;
    }
    setFlavorError("");
    try {
      const { data } = await api.post("/flavors", { name });
      setFlavors((prev) => [...prev, data.flavor].sort((a, b) => a.name.localeCompare(b.name)));
      setRows((prev) => {
        const emptyIdx = prev.findIndex((r) => !r.flavorId);
        if (emptyIdx >= 0) {
          return prev.map((r, i) => (i === emptyIdx ? { ...r, flavorId: data.flavor.id, collapsed: false } : r));
        }
        return [...prev, newFlavorRowState({ flavorId: data.flavor.id })];
      });
      setFlavorDraft("");
      toast(`Flavor "${data.flavor.name}" created`, "success");
    } catch (err) {
      setFlavorError(getFriendlyError(err, "Could not create flavor."));
    }
  }

  function updateFlavorRow(setRows, key, patch) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function updateRecipeLine(setRows, rowKey, lineKey, patch) {
    setRows((prev) =>
      prev.map((r) =>
        r.key === rowKey
          ? { ...r, recipes: (r.recipes ?? []).map((l) => (l.key === lineKey ? { ...l, ...patch } : l)) }
          : r
      )
    );
  }

  function flavorRowsEditor(rows, setRows, sellingPriceText, rowErrors = {}) {
    const sellingPrice = parseMoney(sellingPriceText);
    const knownItems = new Set(itemNames.map((n) => n.name.toLowerCase()));
    const knownUnitOf = (name) =>
      itemNames.find((n) => n.name.toLowerCase() === String(name ?? "").trim().toLowerCase())?.unit ?? "";

    const optionsFor = (currentId) =>
      flavors
        .filter((f) => f.id === currentId || !rows.some((r) => r.flavorId === f.id))
        .map((f) => ({ value: f.id, label: f.name }));

    return (
      <div className="flex flex-col gap-3">
        <datalist id="cartiq-inventory-items">
          {itemNames.map((n) => (
            <option key={n.name} value={n.name} />
          ))}
        </datalist>
        {rows.map((row) => {
          const picked = flavors.find((f) => f.id === row.flavorId);
          const newLines = (row.recipes ?? []).filter((l) => String(l.itemName ?? "").trim()).length;
          
          const priceLabel = String(row.unitPrice ?? "").trim()
            ? `P${Number(row.unitPrice).toLocaleString()}`
            : `Selling Price${sellingPrice !== null ? ` (P${sellingPrice.toLocaleString()})` : ""}`;
            
          const recipeLabel = row.existingRecipeCount > 0
            ? `${row.existingRecipeCount} saved${newLines > 0 ? ` + ${newLines} new` : ""}`
            : newLines > 0 ? `${newLines} new` : "no recipes";
          const hasRecipes = row.existingRecipeCount > 0 || newLines > 0;

          if (row.collapsed) {
            return (
              <div key={row.key} className="flavor-card">
                <button
                  type="button"
                  className="flavor-card-toggle flavor-card-toggle--flat"
                  onClick={() => updateFlavorRow(setRows, row.key, { collapsed: false })}
                  aria-expanded="false"
                  aria-label={`Expand ${picked?.name ?? "flavor row"}`}
                >
                  <span
                    className={`flavor-card-dot ${hasRecipes ? "flavor-card-dot--ok" : "flavor-card-dot--empty"}`}
                    aria-hidden="true"
                  />
                  <span className="flavor-card-name">{picked?.name ?? "Pick a flavor"}</span>
                  <span className="flavor-card-meta">{priceLabel} • {recipeLabel}</span>
                  <span className="flavor-card-chevron" aria-hidden="true">▼</span>
                </button>
              </div>
            );
          }
          return (
            <div key={row.key} className="flavor-card flavor-card--open">
              <button
                type="button"
                className="flavor-card-toggle"
                onClick={() => updateFlavorRow(setRows, row.key, { collapsed: true })}
                aria-expanded="true"
                aria-label={`Collapse ${picked?.name ?? "flavor row"}`}
              >
                <span
                  className={`flavor-card-dot ${hasRecipes ? "flavor-card-dot--ok" : "flavor-card-dot--empty"}`}
                  aria-hidden="true"
                />
                <span className="flavor-card-name">{picked?.name ?? "New flavor"}</span>
                <span className="flavor-card-meta">{priceLabel} • {recipeLabel}</span>
                <span className="flavor-card-chevron" aria-hidden="true">▲</span>
              </button>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                <label className="field">
                  Flavor
                  <Select
                    value={row.flavorId ?? ""}
                    onChange={(v) => updateFlavorRow(setRows, row.key, { flavorId: Number(v) })}
                    options={optionsFor(row.flavorId)}
                    placeholder="Pick a flavor"
                  />
                </label>
                <label className="field">
                  Custom Price (PHP, blank = selling price)
                  <input
                    type="number"
                    min="0"
                    max="9999999.99"
                    step="0.01"
                    placeholder={sellingPrice !== null ? String(sellingPrice) : "Selling price"}
                    title="Leave blank to use the main selling price"
                    value={row.unitPrice}
                    onChange={(e) => updateFlavorRow(setRows, row.key, { unitPrice: sanitizeMoneyInput(e.target.value) })}
                  />
                </label>
              </div>

              {(row.recipes ?? []).map((line) => {
                const typedName = String(line.itemName ?? "").trim();
                const unknownItem = typedName !== "" && !knownItems.has(typedName.toLowerCase());
                const stockUnit = knownUnitOf(line.itemName);
                const unitChoices = unitOptionsFor(stockUnit);
                const effUnit = line.unit || defaultUnitFor(stockUnit);
                return (
                  <div key={line.key}>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 84px 78px 32px", gap: "8px", marginTop: "8px" }}>
                      <input
                        type="text"
                        maxLength={120}
                        placeholder="Ingredient item (e.g. Cheese Powder)"
                        list="cartiq-inventory-items"
                        title="Must match a stock item name exactly — pick from the list"
                        value={line.itemName}
                        onChange={(e) => updateRecipeLine(setRows, row.key, line.key, { itemName: sanitizeTextInput(e.target.value, 120) })}
                      />
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="Qty"
                        title={`Amount deducted per unit sold, in ${effUnit}`}
                        value={line.amount}
                        onChange={(e) => updateRecipeLine(setRows, row.key, line.key, { amount: sanitizeQtyInput(e.target.value) })}
                      />
                      <select
                        aria-label="Unit"
                        title={stockUnit ? `Stock unit is ${stockUnit} — converts automatically` : "Pick the unit"}
                        value={effUnit}
                        onChange={(e) => updateRecipeLine(setRows, row.key, line.key, { unit: e.target.value })}
                      >
                        {unitChoices.map((u) => (
                          <option key={u} value={u}>{u}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="danger-ghost small-btn"
                        title="Remove recipe line"
                        onClick={() => updateFlavorRow(setRows, row.key, { recipes: (row.recipes ?? []).filter((l) => l.key !== line.key) })}
                      >
                        ✕
                      </button>
                    </div>
                    {unknownItem && (
                      <p className="muted small" style={{ margin: "4px 0 0", display: "flex", alignItems: "center", gap: "4px" }}>
                        <AlertTriangle size={12} aria-hidden="true" />
                        No stock item named &rsquo;{typedName}&rsquo; — sales will warn instead of deducting.
                      </p>
                    )}
                  </div>
                );
              })}
              <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
                <button
                  type="button"
                  className="ghost small-btn"
                  onClick={() => updateFlavorRow(setRows, row.key, { recipes: [...(row.recipes ?? []), newRecipeRowState()] })}
                >
                  + Recipe line
                </button>
                <button
                  type="button"
                  className="danger-ghost small-btn"
                  onClick={() => setRows((prev) => prev.filter((r) => r.key !== row.key))}
                >
                  Remove flavor
                </button>
              </div>
              {rowErrors[row.key] && (
                <p className="error-box" role="alert" style={{ margin: "8px 0 0" }}>
                  {rowErrors[row.key]}
                </p>
              )}
              {row.existingRecipeCount > 0 && (
                <p className="muted small" style={{ margin: "8px 0 0" }}>
                  {row.existingRecipeCount} recipe row(s) already saved for {picked?.name ?? "this flavor"} — new lines below are added on save.
                </p>
              )}
              {(row.existingMissing ?? []).length > 0 && (
                <p className="muted small" style={{ margin: "4px 0 0", display: "flex", alignItems: "center", gap: "4px" }}>
                  <AlertTriangle size={12} aria-hidden="true" />
                  No stock row for: {(row.existingMissing ?? []).join(", ")}.
                </p>
              )}
            </div>
          );
        })}
        <div style={{ display: "flex", gap: "8px" }}>
          <button
            type="button"
            className="ghost small-btn"
            onClick={() => setRows((prev) => [...prev, newFlavorRowState()])}
          >
            + Add flavor
          </button>
        </div>
        <div className="field">
          <span>Create flavor</span>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <input
              type="text"
              maxLength={60}
              placeholder="New flavor name"
              value={flavorDraft}
              onChange={(e) => setFlavorDraft(sanitizeTextInput(e.target.value, 60))}
              style={{ flex: 1 }}
            />
            <button
              type="button"
              className="ghost small-btn"
              onClick={() => createFlavorInlineForRows(setRows)}
            >
              Add
            </button>
          </div>
          {flavorError && <p className="error-box" role="alert" style={{ marginTop: "8px" }}>{flavorError}</p>}
        </div>
      </div>
    );
  }

  function checkFlavorRows(rows, sellingPrice) {
    const payload = [];
    const seen = new Set();
    const fail = (row, error) => ({
      ok: false, error, payload: [],
      rowErrors: { [row.key]: error }, badKey: row.key,
    });

    for (const row of rows) {
      if (!row.flavorId) {
        return fail(row, "Pick a flavor for this row (or remove the row).");
      }
      if (seen.has(row.flavorId)) {
        return fail(row, "This flavor is already added below — each flavor can only appear once.");
      }
      seen.add(row.flavorId);

      const flavor = flavors.find((f) => f.id === row.flavorId);
      const entry = { flavorId: row.flavorId };

      const unitText = String(row.unitPrice ?? "").trim();
      if (unitText) {
        const unit = parseMoney(unitText);
        if (unit === null || unit <= 0) {
          return fail(row, `Enter a valid price for "${flavor?.name ?? "this flavor"}" (P0.01 to P9,999,999.99) or leave it blank to use the selling price.`);
        }
        if (unit !== sellingPrice) entry.unitPrice = unit;
      }

      const recipes = [];
      const stockUnitOf = (name) =>
        itemNames.find((n) => n.name.toLowerCase() === String(name ?? "").trim().toLowerCase())?.unit ?? "";

      for (const r of row.recipes ?? []) {
        const itemName = String(r.itemName ?? "").trim();
        const rawAmount = parseQty(String(r.amount ?? ""));
        if (!itemName && (rawAmount === null)) continue;
        if (!itemName || itemName.length > 120) {
          return fail(row, `Recipe rows for "${flavor?.name ?? "this flavor"}" need an item name (max 120 characters).`);
        }
        if (rawAmount === null || rawAmount <= 0) {
          return fail(row, `Recipe rows for "${flavor?.name ?? "this flavor"}" need an amount above 0.`);
        }
        const stockUnit = stockUnitOf(itemName);
        const dispUnit = r.unit || defaultUnitFor(stockUnit);
        const conv = toStockUnit(rawAmount, dispUnit, stockUnit || dispUnit);
        if (!conv.ok) {
          return fail(row, `"${dispUnit}" can't convert to "${stockUnit}" for "${itemName}" — amounts must use compatible units.`);
        }
        if (conv.value <= 0 || conv.value > 99999.99) {
          return fail(row, `Recipe rows for "${flavor?.name ?? "this flavor"}" need an amount from 0.01 to 99,999.99 (in ${stockUnit || dispUnit}).`);
        }
        recipes.push({ itemName, amountPerUnit: conv.value });
      }

      if (recipes.length > 0) entry.recipes = recipes;
      payload.push(entry);
    }
    return { ok: true, payload, rowErrors: {}, badKey: null };
  }

  async function handleAddProduct(e) {
    e.preventDefault();
    setAddError("");

    const name = validateItemName(newProduct.name);
    if (!name.ok) {
      setAddError(name.error);
      return;
    }

    const bp = parseMoney(newProduct.basePrice);
    const mp = parseMoney(newProduct.markupPrice);
    const sp = parseMoney(newProduct.sellingPrice);

    if (sp === null || sp <= 0) {
      setAddError("Selling price must be valid and greater than zero.");
      return;
    }

    const checked = checkFlavorRows(addFlavorRows, sp);
    if (!checked.ok) {
      setAddError(checked.error);
      setAddRowErrors(checked.rowErrors);
      if (checked.badKey) {
        setAddFlavorRows((prev) => prev.map((r) => (r.key === checked.badKey ? { ...r, collapsed: false } : r)));
      }
      return;
    }

    setIsAdding(true);
    try {
      const { data } = await api.post("/products", {
        name: name.value,
        category: newProduct.category.trim() || "Fries",
        basePrice: bp,
        markupPrice: mp,
        sellingPrice: sp,
        flavors: checked.payload,
      });
      toast(
        `Product "${name.value}" created${checked.payload.length ? ` with ${checked.payload.length} flavor(s)` : ""}${data?.recipesCreated ? `, ${data.recipesCreated} recipe row(s)` : ""}`,
        "success"
      );
      closeAddModal();
      setNewProduct({ name: "", category: "Fries", basePrice: "", markupPrice: "", sellingPrice: "" });
      setAddFlavorRows([]);
      setAddRowErrors({});
      setFlavorDraft("");
      load();
    } catch (err) {
      setAddError(getFriendlyError(err, "Failed to create product."));
    } finally {
      setIsAdding(false);
    }
  }

  async function handleEditProduct(e) {
    e.preventDefault();
    setEditError("");

    const bp = parseMoney(editing.basePrice);
    const mp = parseMoney(editing.markupPrice);
    const sp = parseMoney(editing.sellingPrice);

    if (sp === null || sp <= 0) {
      setEditError("Selling price must be valid and greater than zero.");
      return;
    }

    const rows = editing.flavorRows ?? [];
    const checked = checkFlavorRows(rows, sp);
    
    if (!checked.ok) {
      setEditError(checked.error);
      setEditing((prev) => {
        if (!prev) return prev;
        const nextRows = checked.badKey
          ? (prev.flavorRows ?? []).map((r) => (r.key === checked.badKey ? { ...r, collapsed: false } : r))
          : prev.flavorRows;
        return { ...prev, flavorRows: nextRows, rowErrors: checked.rowErrors };
      });
      return;
    }

    const origIds = [...(editing._flavorIds ?? [])].sort((a, b) => a - b);
    const nextIds = checked.payload.map((p) => p.flavorId).sort((a, b) => a - b);
    const sameLinks = origIds.length === nextIds.length &&
      origIds.every((id, i) => id === nextIds[i]);

    const flavorPrices = {};
    const priceChanges = [];
    let pricesChanged = false;
    const baseSnapshot = Number(editing._sellingPrice);

    for (const row of rows) {
      const flavor = flavors.find((f) => f.id === row.flavorId);
      if (!flavor) continue;
      const snap = editing._flavorPrices?.[flavor.name];
      const unitText = String(row.unitPrice ?? "").trim();
      
      const next = unitText ? parseMoney(unitText) : null;
      const normNext = next !== null && next !== sp ? next : null;
      const normSnap = snap !== undefined && snap !== baseSnapshot ? snap : null;
      
      if (normNext !== normSnap) {
        pricesChanged = true;
        flavorPrices[flavor.name] = normNext;
        priceChanges.push(`${flavor.name} P${normSnap ?? baseSnapshot} ➔ P${normNext ?? sp}`);
      }
    }

    const addRecipes = [];
    for (const entry of checked.payload) {
      const flavor = flavors.find((f) => f.id === entry.flavorId);
      for (const r of entry.recipes ?? []) {
        addRecipes.push({ flavor: flavor?.name ?? "", itemName: r.itemName, amountPerUnit: r.amountPerUnit });
      }
    }

    if (
      (editing.category || "Fries") === (editing._category || "Fries") &&
      bp === Number(editing._basePrice) &&
      mp === Number(editing._markupPrice) &&
      sp === Number(editing._sellingPrice) &&
      sameLinks &&
      !pricesChanged &&
      addRecipes.length === 0
    ) {
      toast("No changes — nothing to update on this product.", "info");
      closeEditModal();
      return;
    }

    setIsEditing(true);
    try {
      const body = {
        category: editing.category.trim() || "Fries",
        basePrice: bp,
        markupPrice: mp,
        sellingPrice: sp,
      };
      
      const adds = nextIds.filter((id) => !origIds.includes(id));
      const removes = origIds.filter((id) => !nextIds.includes(id));
      if (adds.length > 0) body.addFlavorIds = adds;
      if (removes.length > 0) body.removeFlavorIds = removes;
      if (pricesChanged) body.flavorPrices = flavorPrices;
      if (addRecipes.length > 0) body.addRecipes = addRecipes;

      const { data } = await api.patch(`/products/${editing.id}`, body);

      const details = [];
      const nameOf = (id) => flavors.find((f) => f.id === id)?.name ?? "a flavor";
      for (const id of adds) details.push(`+${nameOf(id)}`);
      for (const id of removes) details.push(`-${nameOf(id)}`);
      details.push(...priceChanges);
      
      if ((data?.recipesChanged ?? 0) > 0) {
        details.push(`${data.recipesChanged} new recipe row(s)`);
      } else if (addRecipes.length > 0) {
        details.push(`${addRecipes.length} recipe row(s) saved`);
      }
      
      if ((editing.category || "Fries") !== (editing._category || "Fries")) details.push("category updated");
      if (sp !== Number(editing._sellingPrice)) details.push(`selling price P${Number(editing._sellingPrice)} ➔ P${sp}`);

      toast(
        `Product "${editing.name}" updated${details.length ? ` (${details.join("; ")})` : ""}`,
        "success"
      );
      closeEditModal();
      load();
    } catch (err) {
      setEditError(getFriendlyError(err, "Failed to update product."));
    } finally {
      setIsEditing(false);
    }
  }

  async function handleRename(e) {
    e.preventDefault();
    setRenameError("");
    const name = validateItemName(renameName);
    if (!name.ok) {
      setRenameError(name.error);
      return;
    }
    if (name.value.toLowerCase() === renaming.name.toLowerCase()) {
      toast("No changes — that is already the product name.", "info");
      closeRenameModal();
      return;
    }
    setIsRenaming(true);
    try {
      const { data } = await api.patch(`/products/${renaming.id}/rename`, { name: name.value });
      toast(`Renamed to "${name.value}" (${data?.mapsUpdated ?? 0} recipe(s) updated)`, "success");
      closeRenameModal();
      load();
    } catch (err) {
      setRenameError(getFriendlyError(err, "Rename failed."));
    } finally {
      setIsRenaming(false);
    }
  }

  async function handleDelete() {
    if (!deleting || isDeleting) return;
    setIsDeleting(true);
    try {
      await api.del(`/products/${deleting.id}`);
      toast(`Product "${deleting.name}" deleted`, "success");
      load();
    } catch (err) {
      toast(getFriendlyError(err, "Delete failed."), "error");
    } finally {
      setDeleting(null);
      setIsDeleting(false);
    }
  }

  async function handleArchiveToggle() {
    if (!archiving || isArchiving) return;
    const { product, toActive } = archiving;
    setIsArchiving(true);
    try {
      await api.patch(`/products/${product.id}`, { active: toActive });
      toast(
        toActive
          ? `Product "${product.name}" restored to the POS catalog`
          : `Product "${product.name}" archived — hidden from POS, history kept`,
        "success"
      );
      load();
    } catch (err) {
      toast(getFriendlyError(err, toActive ? "Restore failed." : "Archive failed."), "error");
    } finally {
      setArchiving(null);
      setIsArchiving(false);
    }
  }

  function openEdit(p) {
    const prices = p.flavorPrices ?? {};
    const basePriceSnapshot = Number(p.basePrice) || 0;
    const sellingPriceSnapshot = Number(p.sellingPrice ?? p.basePrice) || 0;
    setEditing({
      ...p,
      category: p.category || "Fries",
      basePrice: String(p.basePrice ?? ""),
      markupPrice: String(Math.max(0, sellingPriceSnapshot - basePriceSnapshot)),
      sellingPrice: String(sellingPriceSnapshot),
      flavorRows: (p.flavors ?? []).map((f) => newFlavorRowState({
        flavorId: f.id,
        unitPrice: f.hasCustomPrice ? String(prices[f.name] ?? f.unitPrice ?? "") : "",
        recipes: [],
        existingRecipeCount: f.recipeCount ?? 0,
        existingMissing: f.missingItems ?? [],
        collapsed: (f.recipeCount ?? 0) > 0,
      })),
      _category: p.category || "Fries",
      // The API stores one canonical `basePrice` per product (products.js
      // accepts basePrice/flavorPrices/unitPrice — there is no markupPrice
      // or sellingPrice field). Derive the two form values the pricing grid
      // implies instead of reading fields that never come back. Reading
      // `p.markupPrice` left _markupPrice permanently undefined, so
      // `mp === Number(editing._markupPrice)` below compared against NaN,
      // the no-change guard could never fire, and every "Save Changes"
      // sent a pointless PATCH.
      _basePrice: basePriceSnapshot,
      _markupPrice: Math.max(0, sellingPriceSnapshot - basePriceSnapshot),
      _sellingPrice: sellingPriceSnapshot,
      _flavorIds: (p.flavors ?? []).map((f) => f.id),
      _flavorPrices: prices,
      rowErrors: {},
    });
    setEditError("");
    setFlavorDraft("");
    setFlavorError("");
  }

  function setEditRows(updater) {
    setEditing((prev) => {
      if (!prev) return prev;
      const next = typeof updater === "function" ? updater(prev.flavorRows ?? []) : updater;
      return { ...prev, flavorRows: next, rowErrors: {} };
    });
  }

  if (user && !isOwner) {
    return (
      <PageErrorBoundary>
        <div className="page-container wide">
          <PageHeader eyebrow="Menu" title="Products" sub="Catalog management is OWNER-only." />
          <EmptyState icon={Tag} title="OWNER only" subtitle="Ask an administrator to manage the product catalog." compact />
        </div>
      </PageErrorBoundary>
    );
  }

  return (
    <PageErrorBoundary>
      <div className="page-container wide">
        <PageHeader
          eyebrow="Menu"
          title="Products"
          sub="Catalog items sold at every cart. Price changes affect future sales only."
          actions={
            <>
              <Link to="/data" className="ghost small-btn" style={{ textDecoration: "none" }}>
                Bulk import
              </Link>
              <button
                className="small-btn"
                onClick={() => {
                  setAddError("");
                  setAddRowErrors({});
                  setFlavorDraft("");
                  setFlavorError("");
                  setAddOpen(true);
                }}
              >
                <Plus size={14} /> Add product
              </button>
              <button
                className="ghost small-btn"
                onClick={load}
                disabled={loading}
                title="Refresh products"
              >
                <RefreshCw size={14} className={loading ? "spin" : ""} /> Refresh
              </button>
            </>
          }
        />

        <section className="panel sales-panel">
          {error ? (
            <ErrorBox message={error} onRetry={load} />
          ) : !loading && products.length === 0 ? (
            <EmptyState
              icon={Tag}
              title="No products yet"
              subtitle="Click 'Add product' to start building your catalog."
            />
          ) : (
            <>
              {loading && (
                <p role="status" className="muted small" style={{ margin: "0 0 var(--space-2)" }}>
                  Loading products
                </p>
              )}
              <DataTable
                loading={loading}
                fixedLayout={true}
                columns={[
                  {
                    key: "name",
                    label: "Name",
                    render: (p) => (
                      <span className="flex flex-wrap items-center gap-1">
                        <strong>{p.name}</strong>
                        {p.active === false && <Badge variant="neutral">Archived</Badge>}
                      </span>
                    ),
                  },
                  {
                    key: "category",
                    label: "Category",
                    width: 120,
                    render: (p) => <span className="muted">{p.category}</span>,
                  },
                  {
                    key: "basePrice",
                    label: "Base Price",
                    width: 100,
                    align: "right",
                    render: (p) => <span className="muted">P{Number(p.basePrice ?? 0).toLocaleString()}</span>,
                  },
                  {
                    key: "markupPrice",
                    label: "Markup",
                    width: 100,
                    align: "right",
                    render: (p) => <span className="muted">P{Number(p.markupPrice ?? 0).toLocaleString()}</span>,
                  },
                  {
                    key: "sellingPrice",
                    label: "Selling Price",
                    width: 110,
                    align: "right",
                    render: (p) => <strong>P{Number(p.sellingPrice ?? p.basePrice ?? 0).toLocaleString()}</strong>,
                  },
                  {
                    key: "flavors",
                    label: "Flavors",
                    render: (p) => (
                      <span className="flex flex-wrap gap-1">
                        {(p.flavors ?? []).map((f) => (
                          <Badge
                            key={f.id}
                            variant={(f.recipeCount ?? 0) === 0 || (f.missingItems ?? []).length > 0 ? "warn" : "info"}
                            title={[
                              f.hasCustomPrice ? `P${Number(f.unitPrice).toLocaleString()} — custom price` : `P${Number(f.unitPrice ?? p.sellingPrice ?? p.basePrice).toLocaleString()}`,
                              ...((f.missingItems ?? []).map((m) => `No stock row for "${m}"`)),
                            ].join(" • ")}
                          >
                            {f.name}
                            {f.hasCustomPrice ? ` - P${Number(f.unitPrice).toLocaleString()}` : ""}
                            {((f.recipeCount ?? 0) === 0 || (f.missingItems ?? []).length > 0) && (
                              <AlertTriangle
                                size={11}
                                aria-label={(f.missingItems ?? []).length > 0 ? `Missing stock: ${(f.missingItems ?? []).join(", ")}` : "No recipe"}
                                style={{ marginLeft: 4, verticalAlign: "-1px" }}
                              />
                            )}
                          </Badge>
                        ))}
                        {(p.flavors ?? []).length === 0 && <span className="muted small">—</span>}
                      </span>
                    ),
                  },
                  {
                    key: "usage",
                    label: "Used in",
                    width: 130,
                    render: (p) => (
                      <span className="muted small">
                        {p.recipeCount} recipe(s) • {p.orderLines} order line(s)
                      </span>
                    ),
                  },
                  {
                    key: "actions",
                    label: "",
                    width: 168,
                    align: "right",
                    render: (p) => (
                      <div className="flex items-center justify-end gap-1">
                        <button
                          className="ghost small-btn"
                          onClick={() => openEdit(p)}
                          title="Edit price, flavors, recipes"
                        >
                          <Edit2 size={13} />
                        </button>
                        <button
                          className="ghost small-btn"
                          onClick={() => {
                            setRenaming(p);
                            setRenameName(p.name);
                            setRenameError("");
                          }}
                          title="Rename product"
                        >
                          <Tag size={13} />
                        </button>
                        <button
                          className="ghost small-btn"
                          onClick={() => setArchiving({ product: p, toActive: p.active === false })}
                          title={p.active === false ? "Restore product to POS catalog" : "Archive product (hide from POS)"}
                        >
                          {p.active === false ? <ArchiveRestore size={13} /> : <Archive size={13} />}
                        </button>
                        <button
                          className="danger-ghost small-btn"
                          onClick={() => setDeleting(p)}
                          title="Delete product"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ),
                  },
                ]}
                data={products}
              />
            </>
          )}
        </section>

        {/* ADD PRODUCT MODAL */}
        {(addOpen || addClosing) && (
          <div className={`modal-backdrop ${addClosing ? "is-closing" : ""}`}>
            <div
              className={`modal modal--tall ${addClosing ? "is-closing" : ""}`}
              role="dialog"
              aria-modal="true"
              aria-labelledby="add-product-title"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 id="add-product-title"><Plus size={22} className="muted"/> Add Product</h3>
              <p className="muted" style={{ marginBottom: "20px", lineHeight: "1.4" }}>
                New catalog item for the POS. Base + Markup automatically computes Selling Price.
              </p>

              <form onSubmit={handleAddProduct} className="flex flex-col gap-4">
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}>
                  <label className="field">
                    Product Name
                    <input
                      type="text"
                      required
                      minLength={2}
                      maxLength={30}
                      placeholder="e.g. Nachos"
                      title="Min 2 letters, max 30 characters"
                      value={newProduct.name}
                      onChange={(e) => setNewProduct({ ...newProduct, name: sanitizeTextInput(e.target.value, 30) })}
                      autoFocus
                    />
                  </label>
                  <label className="field">
                    Category
                    <input
                      type="text"
                      maxLength={60}
                      value={newProduct.category}
                      onChange={(e) => setNewProduct({ ...newProduct, category: e.target.value })}
                    />
                  </label>
                </div>

                {/* PRICING GRID */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "20px" }}>
                  <label className="field">
                    Base Price (Cost)
                    <input
                      type="number"
                      min="0"
                      max="9999999.99"
                      step="0.01"
                      placeholder="0.00"
                      title="Whole pesos max 7 digits, up to 2 decimals"
                      value={newProduct.basePrice}
                      onChange={(e) => handleAddPriceChange("basePrice", sanitizeMoneyInput(e.target.value))}
                    />
                  </label>
                  <label className="field">
                    Markup (Tubo)
                    <input
                      type="number"
                      min="0"
                      max="9999999.99"
                      step="0.01"
                      placeholder="0.00"
                      value={newProduct.markupPrice}
                      onChange={(e) => handleAddPriceChange("markupPrice", sanitizeMoneyInput(e.target.value))}
                    />
                  </label>
                  <label className="field">
                    Selling Price
                    <input
                      type="number"
                      min="0"
                      max="9999999.99"
                      step="0.01"
                      required
                      placeholder="0.00"
                      value={newProduct.sellingPrice}
                      onChange={(e) => handleAddPriceChange("sellingPrice", sanitizeMoneyInput(e.target.value))}
                    />
                  </label>
                </div>
                
                <div className="field">
                  <span>Flavors — price &amp; recipes per flavor</span>
                  {flavorRowsEditor(addFlavorRows, setAddRows, newProduct.sellingPrice, addRowErrors)}
                </div>
                
                <div className="modal-actions">
                  <button type="button" className="ghost" onClick={closeAddModal} disabled={isAdding || addClosing}>Cancel</button>
                  <button type="submit" disabled={isAdding || addClosing}>
                    {isAdding ? "Creating..." : "Create Product"}
                  </button>
                </div>
                {addError && <p className="error-box" role="alert" style={{ marginTop: "12px" }}>{addError}</p>}
              </form>
            </div>
          </div>
        )}

        {/* EDIT PRODUCT MODAL */}
        {(editing || editClosing) && (
          <div className={`modal-backdrop ${editClosing ? "is-closing" : ""}`}>
            <div
              className={`modal modal--tall ${editClosing ? "is-closing" : ""}`}
              role="dialog"
              aria-modal="true"
              aria-labelledby="edit-product-title"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 id="edit-product-title"><Edit2 size={22} className="muted"/> Edit {editing?.name}</h3>
              <p className="muted" style={{ marginBottom: "20px", lineHeight: "1.4" }}>
                Price changes affect future sales only — recorded orders keep their totals.
              </p>
              
              <form onSubmit={handleEditProduct} className="flex flex-col gap-4">
                <label className="field">
                  Category
                  <input
                    type="text"
                    maxLength={60}
                    value={editing?.category || ""}
                    onChange={(e) => setEditing({ ...editing, category: e.target.value })}
                  />
                </label>

                {/* PRICING GRID */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "20px" }}>
                  <label className="field">
                    Base Price (Cost)
                    <input
                      type="number"
                      min="0"
                      max="9999999.99"
                      step="0.01"
                      title="Whole pesos max 7 digits, up to 2 decimals"
                      value={editing?.basePrice ?? ""}
                      onChange={(e) => handleEditPriceChange("basePrice", sanitizeMoneyInput(e.target.value))}
                      autoFocus
                    />
                  </label>
                  <label className="field">
                    Markup (Tubo)
                    <input
                      type="number"
                      min="0"
                      max="9999999.99"
                      step="0.01"
                      value={editing?.markupPrice ?? ""}
                      onChange={(e) => handleEditPriceChange("markupPrice", sanitizeMoneyInput(e.target.value))}
                    />
                  </label>
                  <label className="field">
                    Selling Price
                    <input
                      type="number"
                      min="0"
                      max="9999999.99"
                      step="0.01"
                      required
                      value={editing?.sellingPrice ?? ""}
                      onChange={(e) => handleEditPriceChange("sellingPrice", sanitizeMoneyInput(e.target.value))}
                    />
                  </label>
                </div>
                
                <div className="field">
                  <span>Flavors — price &amp; recipes per flavor</span>
                  {flavorRowsEditor(editing?.flavorRows ?? [], setEditRows, editing?.sellingPrice, editing?.rowErrors ?? {})}
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

        {/* RENAME PRODUCT MODAL */}
        {(renaming || renameClosing) && (
          <div className={`modal-backdrop ${renameClosing ? "is-closing" : ""}`}>
            <div className={`modal ${renameClosing ? "is-closing" : ""}`} onClick={(e) => e.stopPropagation()}>
              <h3><Tag size={22} className="muted"/> Rename {renaming?.name}</h3>
              <form onSubmit={handleRename} className="flex flex-col gap-4">
                <label className="field">
                  Product Name
                  <input
                    type="text"
                    required
                    minLength={2}
                    maxLength={30}
                    title="Min 2 letters, max 30 characters"
                    value={renameName}
                    onChange={(e) => setRenameName(sanitizeTextInput(e.target.value, 30))}
                    autoFocus
                  />
                </label>
                <div className="modal-actions">
                  <button type="button" className="ghost" onClick={closeRenameModal} disabled={isRenaming || renameClosing}>Cancel</button>
                  <button type="submit" disabled={isRenaming || renameClosing}>
                    {isRenaming ? "Saving..." : "Rename"}
                  </button>
                </div>
                {renameError && <p className="error-box" role="alert" style={{ marginTop: "12px" }}>{renameError}</p>}
              </form>
            </div>
          </div>
        )}

        {/* ARCHIVE / RESTORE CONFIRMATION */}
        <ConfirmDialog
          open={Boolean(archiving)}
          title={
            archiving?.toActive ? "Restore product?" : "Archive product?"
          }
          message={
            archiving
              ? archiving.toActive
                ? `"${archiving.product.name}" will show up in the POS catalog again. Its history is untouched.`
                : `"${archiving.product.name}" will be hidden from the POS catalog. Sales history and reports are kept.`
              : ""
          }
          confirmLabel={archiving?.toActive ? "Restore Product" : "Archive Product"}
          pending={isArchiving}
          pendingLabel={archiving?.toActive ? "Restoring..." : "Archiving..."}
          onConfirm={handleArchiveToggle}
          onCancel={() => setArchiving(null)}
        />

        {/* DELETE PRODUCT CONFIRMATION */}
        <ConfirmDialog
          open={Boolean(deleting)}
          title="Delete product?"
          message={
            deleting
              ? `"${deleting.name}" will be completely removed from the catalog. Historical sales data remains unaffected. This action cannot be undone.`
              : ""
          }
          confirmLabel="Delete Product"
          danger
          pending={isDeleting}
          pendingLabel="Deleting..."
          onConfirm={handleDelete}
          onCancel={() => setDeleting(null)}
        />
      </div>
    </PageErrorBoundary>
  );
}