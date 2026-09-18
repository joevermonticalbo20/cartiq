import { useCallback, useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { Plus, Edit2, Trash2, RefreshCw, Tag, AlertTriangle } from "lucide-react";

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
    ...overrides,
  };
}

export default function ProductsPage() {
  const toast = useToast();
  const { user } = useOutletContext();
  const isOwner = user?.role === "OWNER";

  const [products, setProducts] = useState([]);
  const [flavors, setFlavors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [addOpen, setAddOpen] = useState(false);
  const [addClosing, setAddClosing] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [addError, setAddError] = useState("");
  const [newProduct, setNewProduct] = useState({ name: "", category: "Fries", basePrice: "" });
  // Per-flavor rows: [{ key, flavorId, unitPrice, recipes: [{ key, itemName, amount }] }].
  // unitPrice blank = use the product base price.
  const [addFlavorRows, setAddFlavorRows] = useState([]);
  const [addRowErrors, setAddRowErrors] = useState({});
  // Row edits clear row-level errors so fixed rows stop showing red.
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

  const [flavorDraft, setFlavorDraft] = useState("");
  const [flavorError, setFlavorError] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([api.get("/products"), api.get("/flavors")])
      .then(([p, f]) => {
        setProducts(p.data?.data ?? []);
        setFlavors(f.data?.data ?? []);
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

  // Per-flavor row editor shared by the Add and Edit modals. Recipes are
  // optional: rows without recipes still submit.
  // rowErrors maps row.key -> inline message; any row edit clears them.
  function flavorRowsEditor(rows, setRows, basePriceText, rowErrors = {}) {
    const basePrice = parseMoney(basePriceText);
    const optionsFor = (currentId) =>
      flavors
        .filter((f) => f.id === currentId || !rows.some((r) => r.flavorId === f.id))
        .map((f) => ({ value: f.id, label: f.name }));

    return (
      <div className="flex flex-col gap-3">
        {rows.map((row) => {
          const picked = flavors.find((f) => f.id === row.flavorId);
          const newLines = (row.recipes ?? []).filter((l) => String(l.itemName ?? "").trim()).length;
          const priceLabel = String(row.unitPrice ?? "").trim()
            ? `P${Number(row.unitPrice).toLocaleString()}`
            : `Base${basePrice !== null ? ` (P${basePrice.toLocaleString()})` : ""}`;
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
                  <span className="flavor-card-meta">{priceLabel} · {recipeLabel}</span>
                  <span className="flavor-card-chevron" aria-hidden="true">▾</span>
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
                <span className="flavor-card-meta">{priceLabel} · {recipeLabel}</span>
                <span className="flavor-card-chevron" aria-hidden="true">▴</span>
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
                  Price (PHP, blank = base)
                  <input
                    type="number"
                    min="0"
                    max="9999999.99"
                    step="0.01"
                    placeholder={basePrice !== null ? String(basePrice) : "Base price"}
                    title="Leave blank to use the base price"
                    value={row.unitPrice}
                    onChange={(e) => updateFlavorRow(setRows, row.key, { unitPrice: sanitizeMoneyInput(e.target.value) })}
                  />
                </label>
              </div>

              {(row.recipes ?? []).map((line) => (
                <div key={line.key} style={{ display: "grid", gridTemplateColumns: "1fr 120px 32px", gap: "8px", marginTop: "8px" }}>
                  <input
                    type="text"
                    maxLength={120}
                    placeholder="Ingredient item (e.g. Cheese Powder)"
                    value={line.itemName}
                    onChange={(e) => updateRecipeLine(setRows, row.key, line.key, { itemName: sanitizeTextInput(e.target.value, 120) })}
                  />
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="Qty / unit"
                    title="Amount deducted per unit sold"
                    value={line.amount}
                    onChange={(e) => updateRecipeLine(setRows, row.key, line.key, { amount: sanitizeQtyInput(e.target.value) })}
                  />
                  <button
                    type="button"
                    className="danger-ghost small-btn"
                    title="Remove recipe line"
                    onClick={() => updateFlavorRow(setRows, row.key, { recipes: (row.recipes ?? []).filter((l) => l.key !== line.key) })}
                  >
                    ×
                  </button>
                </div>
              ))}

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

  async function handleAddProduct(e) {
    e.preventDefault();
    setAddError("");

    const name = validateItemName(newProduct.name);
    if (!name.ok) {
      setAddError(name.error);
      return;
    }

    const price = parseMoney(newProduct.basePrice);
    if (price === null || price <= 0) {
      setAddError("Enter a base price from P0.01 to P9,999,999.99.");
      return;
    }

    const checked = checkFlavorRows(addFlavorRows, price);
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
        basePrice: price,
        flavors: checked.payload,
      });
      toast(
        `Product "${name.value}" created${checked.payload.length ? ` with ${checked.payload.length} flavor(s)` : ""}${data?.recipesCreated ? `, ${data.recipesCreated} recipe row(s)` : ""}`,
        "success"
      );
      closeAddModal();
      setNewProduct({ name: "", category: "Fries", basePrice: "" });
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

  // Validate per-flavor rows shared by Add and Edit. Returns
  // { ok, error?, payload?, rowErrors?, badKey? } where payload matches
  // POST /products flavors[]. Recipes are optional. Failures carry a
  // per-row message (shown inline under the row) plus badKey
  // (auto-expanded on submit).
  function checkFlavorRows(rows, basePrice) {
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
          return fail(row, `Enter a valid price for "${flavor?.name ?? "this flavor"}" (P0.01 to P9,999,999.99) or leave it blank to use the base price.`);
        }
        if (unit !== basePrice) entry.unitPrice = unit;
      }
      const recipes = [];
      for (const r of row.recipes ?? []) {
        const itemName = String(r.itemName ?? "").trim();
        const amount = parseQty(String(r.amount ?? ""));
        if (!itemName && (amount === null)) continue; // skip untouched blank lines
        if (!itemName || itemName.length > 120) {
          return fail(row, `Recipe rows for "${flavor?.name ?? "this flavor"}" need an item name (max 120 characters).`);
        }
        if (amount === null || amount <= 0) {
          return fail(row, `Recipe rows for "${flavor?.name ?? "this flavor"}" need an amount from 0.01 to 99,999.99.`);
        }
        recipes.push({ itemName, amountPerUnit: amount });
      }
      if (recipes.length > 0) entry.recipes = recipes;
      payload.push(entry);
    }
    return { ok: true, payload, rowErrors: {}, badKey: null };
  }

  async function handleEditProduct(e) {
    e.preventDefault();
    setEditError("");

    const price = parseMoney(editing.basePrice);
    if (price === null || price <= 0) {
      setEditError("Enter a base price from P0.01 to P9,999,999.99.");
      return;
    }

    const rows = editing.flavorRows ?? [];
    const checked = checkFlavorRows(rows, price);
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

    // Per-flavor price overrides that changed vs the snapshot, with labels
    // for the success message (effective old price -> effective new price).
    const flavorPrices = {};
    const priceChanges = [];
    let pricesChanged = false;
    const baseSnapshot = Number(editing._basePrice);
    for (const row of rows) {
      const flavor = flavors.find((f) => f.id === row.flavorId);
      if (!flavor) continue;
      const snap = editing._flavorPrices?.[flavor.name];
      const unitText = String(row.unitPrice ?? "").trim();
      const next = unitText ? parseMoney(unitText) : null;
      const normNext = next !== null && next !== price ? next : null;
      const normSnap = snap !== undefined && snap !== baseSnapshot ? snap : null;
      if (normNext !== normSnap) {
        pricesChanged = true;
        flavorPrices[flavor.name] = normNext;
        priceChanges.push(`${flavor.name} P${normSnap ?? baseSnapshot}→P${normNext ?? price}`);
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
      price === Number(editing._basePrice) &&
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
        basePrice: price,
      };
      const adds = nextIds.filter((id) => !origIds.includes(id));
      const removes = origIds.filter((id) => !nextIds.includes(id));
      if (adds.length > 0) body.addFlavorIds = adds;
      if (removes.length > 0) body.removeFlavorIds = removes;
      if (pricesChanged) body.flavorPrices = flavorPrices;
      if (addRecipes.length > 0) body.addRecipes = addRecipes;
      const { data } = await api.patch(`/products/${editing.id}`, body);
      // Say exactly what changed: added/removed flavors, price moves,
      // new recipe rows — or category/base when those moved alone.
      const details = [];
      const nameOf = (id) => flavors.find((f) => f.id === id)?.name ?? "a flavor";
      for (const id of adds) details.push(`+${nameOf(id)}`);
      for (const id of removes) details.push(`−${nameOf(id)}`);
      details.push(...priceChanges);
      if ((data?.recipesChanged ?? 0) > 0) {
        details.push(`${data.recipesChanged} new recipe row(s)`);
      } else if (addRecipes.length > 0) {
        details.push(`${addRecipes.length} recipe row(s) saved`);
      }
      if ((editing.category || "Fries") !== (editing._category || "Fries")) details.push("category updated");
      if (price !== Number(editing._basePrice)) details.push(`base price P${Number(editing._basePrice)}→P${price}`);
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

  function openEdit(p) {
    const prices = p.flavorPrices ?? {};
    setEditing({
      ...p,
      category: p.category || "Fries",
      basePrice: String(p.basePrice ?? ""),
      flavorRows: (p.flavors ?? []).map((f) => newFlavorRowState({
        flavorId: f.id,
        unitPrice: f.hasCustomPrice ? String(prices[f.name] ?? f.unitPrice ?? "") : "",
        recipes: [],
        existingRecipeCount: f.recipeCount ?? 0,
        // Saved rows start collapsed so long flavor lists stay scannable.
        collapsed: (f.recipeCount ?? 0) > 0,
      })),
      _category: p.category || "Fries",
      _basePrice: p.basePrice,
      _flavorIds: (p.flavors ?? []).map((f) => f.id),
      _flavorPrices: prices,
      rowErrors: {},
    });
    setEditError("");
    setFlavorDraft("");
    setFlavorError("");
  }

  // Edit-modal row setter: supports updater fn or value, clears row errors.
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
                  Loading products…
                </p>
              )}
              <DataTable
                loading={loading}
              fixedLayout={true}
              columns={[
                {
                  key: "name",
                  label: "Name",
                  render: (p) => <strong>{p.name}</strong>,
                },
                {
                  key: "category",
                  label: "Category",
                  width: 120,
                  render: (p) => <span className="muted">{p.category}</span>,
                },
                {
                  key: "basePrice",
                  label: "Price",
                  width: 100,
                  align: "right",
                  render: (p) => <strong>P{Number(p.basePrice).toLocaleString()}</strong>,
                },
                {
                  key: "flavors",
                  label: "Flavors",
                  render: (p) => (
                    <span className="flex flex-wrap gap-1">
                      {(p.flavors ?? []).map((f) => (
                        <Badge
                          key={f.id}
                          variant={f.recipeCount === 0 ? "warn" : "info"}
                          title={f.hasCustomPrice ? `P${Number(f.unitPrice).toLocaleString()} — custom price` : `P${Number(f.unitPrice ?? p.basePrice).toLocaleString()}`}
                        >
                          {f.name}
                          {f.hasCustomPrice ? ` · P${Number(f.unitPrice).toLocaleString()}` : ""}
                          {f.recipeCount === 0 && (
                            <AlertTriangle
                              size={11}
                              aria-label="No recipe"
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
                      {p.recipeCount} recipe(s) · {p.orderLines} order line(s)
                    </span>
                  ),
                },
                {
                  key: "actions",
                  label: "",
                  width: 120,
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
            <div className={`modal modal--tall ${addClosing ? "is-closing" : ""}`} onClick={(e) => e.stopPropagation()}>
              <h3><Plus size={22} className="muted"/> Add Product</h3>
              <p className="muted" style={{ marginBottom: "20px", lineHeight: "1.4" }}>
                New catalog item for the POS. Add each flavor below with its own price and recipe rows.
              </p>

              <form onSubmit={handleAddProduct} className="flex flex-col gap-4">
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
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}>
                  <label className="field">
                    Category
                    <input
                      type="text"
                      maxLength={60}
                      value={newProduct.category}
                      onChange={(e) => setNewProduct({ ...newProduct, category: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    Base Price (PHP)
                    <input
                      type="number"
                      min="0"
                      max="9999999.99"
                      step="0.01"
                      required
                      placeholder="0.00"
                      title="Whole pesos max 7 digits, up to 2 decimals"
                      value={newProduct.basePrice}
                      onChange={(e) => setNewProduct({ ...newProduct, basePrice: sanitizeMoneyInput(e.target.value) })}
                    />
                  </label>
                </div>
                
                <div className="field">
                  <span>Flavors — price &amp; recipes per flavor</span>
                  {flavorRowsEditor(addFlavorRows, setAddRows, newProduct.basePrice, addRowErrors)}
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
            <div className={`modal modal--tall ${editClosing ? "is-closing" : ""}`} onClick={(e) => e.stopPropagation()}>
              <h3><Edit2 size={22} className="muted"/> Edit {editing?.name}</h3>
              <p className="muted" style={{ marginBottom: "20px", lineHeight: "1.4" }}>
                Price changes affect future sales only — recorded orders keep their totals.
              </p>

              <form onSubmit={handleEditProduct} className="flex flex-col gap-4">
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}>
                  <label className="field">
                    Category
                    <input
                      type="text"
                      maxLength={60}
                      value={editing?.category || ""}
                      onChange={(e) => setEditing({ ...editing, category: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    Base Price (PHP)
                    <input
                      type="number"
                      min="0"
                      max="9999999.99"
                      step="0.01"
                      required
                      title="Whole pesos max 7 digits, up to 2 decimals"
                      value={editing?.basePrice ?? ""}
                      onChange={(e) => setEditing({ ...editing, basePrice: sanitizeMoneyInput(e.target.value) })}
                      autoFocus
                    />
                  </label>
                </div>
                
                <div className="field">
                  <span>Flavors — price &amp; recipes per flavor</span>
                  {editing && flavorRowsEditor(
                    editing.flavorRows ?? [],
                    setEditRows,
                    editing.basePrice,
                    editing.rowErrors ?? {}
                  )}
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
              <p className="muted" style={{ marginBottom: "20px", lineHeight: "1.4" }}>
                Recipe rows follow the new name automatically. Past orders keep the old name.
              </p>

              <form onSubmit={handleRename} className="flex flex-col gap-4">
                <label className="field">
                  New Name
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
                    {isRenaming ? "Renaming..." : "Rename"}
                  </button>
                </div>
                {renameError && <p className="error-box" role="alert" style={{ marginTop: "12px" }}>{renameError}</p>}
              </form>
            </div>
          </div>
        )}

        {/* DELETE PRODUCT CONFIRMATION */}
        <ConfirmDialog
          open={Boolean(deleting)}
          title="Delete product?"
          message={deleting
            ? `"${deleting.name}" is used in ${deleting.recipeCount} recipe(s) and ${deleting.orderLines} order line(s). Delete is blocked while any reference exists.`
            : ""}
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
