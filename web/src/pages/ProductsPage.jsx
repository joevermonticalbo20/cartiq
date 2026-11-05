import { useCallback, useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { Plus, Edit2, Trash2, RefreshCw, Tag, AlertTriangle, Archive, ArchiveRestore, Star, ImagePlus } from "lucide-react";
import api from "../api.js";
import { getFriendlyError } from "../utils/errors.js";
import DataTable from "../components/DataTable.jsx";
import EmptyState from "../components/EmptyState.jsx";
import ErrorBox from "../components/ErrorBox.jsx";
import ConfirmDialog from "../components/ConfirmDialog.jsx";
import ImageCropDialog from "../components/ImageCropDialog.jsx";
import PageErrorBoundary from "../components/PageErrorBoundary.jsx";
import PageHeader from "../components/PageHeader.jsx";
import { useToast } from "../components/Toast.jsx";
import { sanitizeMoneyInput, sanitizeQtyInput, parseMoney, parseQty } from "../utils/format.js";
import { sanitizeTextInput, validateItemName } from "../utils/text.js";

let recipeRowSeq = 1;
function newRecipeRowState(overrides = {}) {
  return {
    key: `rr-${Date.now()}-${recipeRowSeq++}`,
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
  const [itemNames, setItemNames] = useState([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [addOpen, setAddOpen] = useState(false);
  const [addClosing, setAddClosing] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [addError, setAddError] = useState("");
  const [newProduct, setNewProduct] = useState({ name: "", category: "Fries", basePrice: "", markupPrice: "", sellingPrice: "", imageDraft: null });

  // Insert/crop photo dialog: which modal asked for it ("add" | "edit").
  const [cropState, setCropState] = useState({ open: false, target: null });
  const [starring, setStarring] = useState(null);

  // Flat recipe rows (the size-to-product catalog carries recipes on the
  // product itself — there is no per-variant option anymore).
  const [addRecipeRows, setAddRecipeRows] = useState([]);

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

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([api.get("/products"), api.get("/inventory/names").catch(() => ({ data: { data: [] } }))])
      .then(([p, n]) => {
        setProducts(p.data?.data ?? []);
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

  function updateRecipeLineFlat(setLines, key, patch) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function flatRecipesEditor(lines, setLines) {
    const knownItems = new Set(itemNames.map((n) => n.name.toLowerCase()));
    const knownUnitOf = (name) =>
      itemNames.find((n) => n.name.toLowerCase() === String(name ?? "").trim().toLowerCase())?.unit ?? "";

    return (
      <div className="flex flex-col gap-3">
        <datalist id="cartiq-inventory-items">
          {itemNames.map((n) => (
            <option key={n.name} value={n.name} />
          ))}
        </datalist>
        {lines.length === 0 && (
          <p className="muted small">
            No recipe lines yet. The product sells at its selling price and deducts nothing from stock until you add ingredient lines.
          </p>
        )}
        {lines.map((line) => {
          const typedName = String(line.itemName ?? "").trim();
          const unknownItem = typedName !== "" && !knownItems.has(typedName.toLowerCase());
          const stockUnit = knownUnitOf(line.itemName);
          const unitChoices = unitOptionsFor(stockUnit);
          const effUnit = line.unit || defaultUnitFor(stockUnit);
          return (
            <div key={line.key}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 84px 78px 32px", gap: "8px" }}>
                <input
                  type="text"
                  maxLength={120}
                  placeholder="Ingredient item (e.g. Cheese Powder)"
                  list="cartiq-inventory-items"
                  title="Must match a stock item name exactly - pick from the list"
                  value={line.itemName}
                  onChange={(e) =>
                    updateRecipeLineFlat(setLines, line.key, { itemName: sanitizeTextInput(e.target.value, 120) })
                  }
                />
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="Qty"
                  title={`Amount deducted per unit sold, in ${effUnit}`}
                  value={line.amount}
                  onChange={(e) =>
                    updateRecipeLineFlat(setLines, line.key, { amount: sanitizeQtyInput(e.target.value) })
                  }
                />
                <select
                  aria-label="Unit"
                  title={stockUnit ? `Stock unit is ${stockUnit} - converts automatically` : "Pick the unit"}
                  value={effUnit}
                  onChange={(e) => updateRecipeLineFlat(setLines, line.key, { unit: e.target.value })}
                >
                  {unitChoices.map((u) => (
                    <option key={u} value={u}>{u}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className="danger-ghost small-btn"
                  title="Remove recipe line"
                  onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
                >
                  \u2715
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
        <button
          type="button"
          className="ghost small-btn"
          style={{ alignSelf: "flex-start" }}
          onClick={() => setLines((prev) => [...prev, newRecipeRowState()])}
        >
          + Recipe line
        </button>
      </div>
    );
  }

  function checkFlatRecipes(lines) {
    const recipes = [];
    const stockUnitOf = (name) =>
      itemNames.find((n) => n.name.toLowerCase() === String(name ?? "").trim().toLowerCase())?.unit ?? "";

    for (const r of lines) {
      const itemName = String(r.itemName ?? "").trim();
      const rawAmount = parseQty(String(r.amount ?? ""));
      if (!itemName && rawAmount === null) continue;
      if (!itemName || itemName.length > 120) {
        return { ok: false, error: "Recipe lines need an item name (max 120 characters)." };
      }
      if (rawAmount === null || rawAmount <= 0) {
        return { ok: false, error: `Recipe line for "${itemName}" needs an amount above 0.` };
      }
      const stockUnit = stockUnitOf(itemName);
      const dispUnit = r.unit || defaultUnitFor(stockUnit);
      const conv = toStockUnit(rawAmount, dispUnit, stockUnit || dispUnit);
      if (!conv.ok) {
        return { ok: false, error: `"${dispUnit}" can't convert to "${stockUnit}" for "${itemName}" — amounts must use compatible units.` };
      }
      if (conv.value <= 0 || conv.value > 99999.99) {
        return { ok: false, error: `Recipe line for "${itemName}" needs an amount from 0.01 to 99,999.99 (in ${stockUnit || dispUnit}).` };
      }
      recipes.push({ itemName, amountPerUnit: conv.value });
    }
    return { ok: true, recipes };
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

    const checked = checkFlatRecipes(addRecipeRows);
    if (!checked.ok) {
      setAddError(checked.error);
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
      });
      const newId = data?.product?.id;
      if (newId && checked.recipes.length > 0) {
        try {
          await api.patch(`/products/${newId}`, {
            addRecipes: checked.recipes.map((r) => ({ flavor: "", ...r })),
          });
        } catch (recErr) {
          toast(getFriendlyError(recErr, "Product created but its recipe lines could not be saved — open Edit and save them again."), "error");
        }
      }
      // The cropped photo needs the new product's id; a failed upload warns
      // instead of pretending the whole create failed.
      if (newProduct.imageDraft && data?.product?.id) {
        try {
          await uploadProductImage(data.product.id, newProduct.imageDraft);
        } catch (imgErr) {
          toast(getFriendlyError(imgErr, "Product created, but the photo upload failed."), "error");
        }
      }
      toast(
        `Product "${name.value}" created${checked.recipes.length ? ` with ${checked.recipes.length} recipe line(s)` : ""}`,
        "success"
      );
      closeAddModal();
      setNewProduct({ name: "", category: "Fries", basePrice: "", markupPrice: "", sellingPrice: "", imageDraft: null });
      setAddRecipeRows([]);
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

    // Flat recipe lines (flavor "" = the product itself).
    const lines = editing.recipeLines ?? [];
    const checked = checkFlatRecipes(lines);
    if (!checked.ok) {
      setEditError(checked.error);
      return;
    }
    const baseline = editing._recipeBaseline ?? [];
    const keepPair = (a, b) =>
      a.itemName === b.itemName && Number(a.amountPerUnit) === Number(b.amountPerUnit);
    const unchanged =
      checked.recipes.length === baseline.length &&
      checked.recipes.every((r) => baseline.some((b) => keepPair(r, b)));
    const keptNames = new Set(checked.recipes.map((r) => r.itemName));
    const removeRecipes = unchanged
      ? []
      : baseline
          .filter((b) => !keptNames.has(b.itemName))
          .map((b) => ({ flavor: "", itemName: b.itemName }));
    const addRecipes = unchanged
      ? []
      : checked.recipes.map((r) => ({ flavor: "", ...r }));

    // A pending cropped photo is a change even when no field moved.
    const hasImageDraft = Boolean(editing.imageDraft);

    if (
      (editing.category || "Fries") === (editing._category || "Fries") &&
      bp === Number(editing._basePrice) &&
      mp === Number(editing._markupPrice) &&
      sp === Number(editing._sellingPrice) &&
      !hasImageDraft &&
      addRecipes.length === 0 &&
      removeRecipes.length === 0
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
      if (addRecipes.length > 0) body.addRecipes = addRecipes;
      if (removeRecipes.length > 0) body.removeRecipes = removeRecipes;

      const { data } = await api.patch(`/products/${editing.id}`, body);

      const details = [];
      if ((data?.recipesChanged ?? 0) > 0) {
        details.push(`${data.recipesChanged} recipe row(s) saved`);
      } else if (addRecipes.length > 0) {
        details.push(`${addRecipes.length} recipe row(s) saved`);
      }
      if (removeRecipes.length > 0) details.push(`${removeRecipes.length} recipe row(s) removed`);
      
      if ((editing.category || "Fries") !== (editing._category || "Fries")) details.push("category updated");
      if (sp !== Number(editing._sellingPrice)) details.push(`selling price P${Number(editing._sellingPrice)} ➔ P${sp}`);
      if (hasImageDraft) {
        try {
          await uploadProductImage(editing.id, editing.imageDraft);
          details.push("photo updated");
        } catch (imgErr) {
          toast(getFriendlyError(imgErr, "Product saved, but the photo upload failed."), "error");
        }
      }

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

  // --- PRODUCT PHOTOS ---------------------------------------------------
  // The cropped photo is uploaded right after the product save lands
  // (create) or after the PATCH (edit): the endpoints need a product id.
  async function uploadProductImage(productId, draft) {
    const comma = draft.dataUrl.indexOf(",");
    const data = draft.dataUrl.slice(comma + 1);
    await api.post(`/products/${productId}/image`, { data, mime: draft.mime });
  }

  function openCrop(target) {
    setCropState({ open: true, target });
  }

  function handleCropSave({ dataUrl, mime }) {
    const draft = { dataUrl, mime };
    if (cropState.target === "add") {
      setNewProduct((prev) => ({ ...prev, imageDraft: draft }));
    } else if (cropState.target === "edit") {
      setEditing((prev) => (prev ? { ...prev, imageDraft: draft } : prev));
    }
    setCropState({ open: false, target: null });
  }

  async function handleRemoveImage() {
    if (!editing) return;
    try {
      await api.del(`/products/${editing.id}/image`);
      // Seeded products carry a pasted URL instead of an upload; clear it
      // too so the list stops serving the old photo.
      await api.patch(`/products/${editing.id}`, { imageUrl: null });
      setEditing((prev) => (prev ? { ...prev, imageUrl: "", imageDraft: null } : prev));
      toast("Product photo removed", "success");
      load();
    } catch (err) {
      toast(getFriendlyError(err, "Could not remove the photo."), "error");
    }
  }

  function handleRemoveDraft() {
    setNewProduct((prev) => ({ ...prev, imageDraft: null }));
    setEditing((prev) => (prev ? { ...prev, imageDraft: null } : prev));
  }

  // --- BEST SELLER STAR -------------------------------------------------
  // The POS "Best Sellers" filter reads isBestSeller; the star is the one
  // control that sets it, so the owner curates that category by hand.
  async function handleBestSellerToggle(p) {
    if (starring) return;
    setStarring(p.id);
    try {
      const next = !(p.isBestSeller === true);
      await api.patch(`/products/${p.id}`, { isBestSeller: next });
      toast(
        next
          ? `"${p.name}" added to Best Sellers`
          : `"${p.name}" removed from Best Sellers`,
        "success"
      );
      load();
    } catch (err) {
      toast(getFriendlyError(err, "Could not update the Best Seller mark."), "error");
    } finally {
      setStarring(null);
    }
  }

  function productImageField({ draft, existingUrl, onInsert, onRemove }) {
    const preview = draft?.dataUrl ?? existingUrl ?? null;
    return (
      <div className="field">
        <span>Product photo</span>
        <div style={{ display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={onInsert}
            title="Insert or crop a photo"
            style={{
              padding: 0,
              border: "1px solid var(--border)",
              borderRadius: 14,
              overflow: "hidden",
              background: "var(--surface-alt)",
              width: 72,
              height: 72,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              flex: "0 0 auto",
            }}
          >
            {preview ? (
              <img
                src={preview}
                alt=""
                style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
              />
            ) : (
              <ImagePlus size={22} className="muted" aria-hidden="true" />
            )}
          </button>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <button type="button" className="ghost small-btn" onClick={onInsert}>
                <ImagePlus size={13} /> {preview ? "Change / crop" : "Insert photo"}
              </button>
              {preview && (
                <button type="button" className="danger-ghost small-btn" onClick={onRemove}>
                  Remove
                </button>
              )}
            </div>
            <span className="muted small">
              Click the image to crop it. The square is what the POS card shows.
            </span>
          </div>
        </div>
      </div>
    );
  }

  function openEdit(p) {
    const basePriceSnapshot = Number(p.basePrice) || 0;
    const sellingPriceSnapshot = Number(p.sellingPrice ?? p.basePrice) || 0;
    const flatRecipes = (p.recipes ?? []).map((r) =>
      newRecipeRowState({ itemName: String(r.itemName ?? ""), amount: String(r.amountPerUnit ?? "") }));
    setEditing({
      ...p,
      category: p.category || "Fries",
      basePrice: String(p.basePrice ?? ""),
      markupPrice: String(Math.max(0, sellingPriceSnapshot - basePriceSnapshot)),
      sellingPrice: String(sellingPriceSnapshot),
      imageUrl: p.imageUrl ?? "",
      imageDraft: null,
      recipeLines: flatRecipes,
      _recipeBaseline: flatRecipes.map((r) => ({ itemName: r.itemName, amountPerUnit: Number(r.amount) || 0 })),
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
    });
    setEditError("");
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
                  setAddRecipeRows([]);
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
                    width: 200,
                    render: (p) => (
                      <span className="flex flex-wrap items-center gap-1">
                        <button
                          type="button"
                          className="linklike"
                          onClick={() => handleBestSellerToggle(p)}
                          disabled={starring === p.id}
                          aria-pressed={p.isBestSeller === true}
                          title={p.isBestSeller === true ? "Remove from Best Sellers" : "Add to Best Sellers"}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            padding: 2,
                            flex: "0 0 auto",
                            color: p.isBestSeller === true ? "var(--highlight-strong)" : "var(--text-faint)",
                          }}
                        >
                          <Star size={15} fill={p.isBestSeller === true ? "currentColor" : "none"} aria-hidden="true" />
                        </button>
                        {p.imageUrl && (
                          <img
                            src={p.imageUrl}
                            alt=""
                            width={28}
                            height={28}
                            loading="lazy"
                            style={{ width: 28, height: 28, borderRadius: 8, objectFit: "cover", flex: "0 0 auto" }}
                          />
                        )}
                        <strong>{p.name}</strong>
                      </span>
                    ),
                  },
                  {
                    key: "category",
                    label: "Category",
                    width: 100,
                    render: (p) => <span className="muted">{p.category}</span>,
                  },
                  {
                    key: "basePrice",
                    label: "Base Price",
                    width: 86,
                    align: "right",
                    render: (p) => <span className="muted">P{Number(p.basePrice ?? 0).toLocaleString()}</span>,
                  },
                  {
                    key: "markupPrice",
                    label: "Markup",
                    width: 86,
                    align: "right",
                    render: (p) => <span className="muted">P{Number(p.markupPrice ?? 0).toLocaleString()}</span>,
                  },
                  {
                    key: "sellingPrice",
                    label: "Selling Price",
                    width: 96,
                    align: "right",
                    render: (p) => <strong>P{Number(p.sellingPrice ?? p.basePrice ?? 0).toLocaleString()}</strong>,
                  },
                  {
                    key: "recipes",
                    // The catalog is flat (each size is its own product).
                    // What matters per product is whether it deducts stock:
                    // recipe rows and any stock item it can't find.
                    label: "Recipes",
                    width: 110,
                    render: (p) => {
                      const count = p.recipeCount ?? 0;
                      const missing = p.missingItems ?? [];
                      const warn = count === 0 || missing.length > 0;
                      const title = missing.length > 0
                        ? `No stock row for: ${missing.join(", ")}`
                        : count === 0
                          ? "No recipe — selling deducts nothing"
                          : `${count} recipe row(s)`;
                      return (
                        <span
                          className="muted small"
                          title={title}
                          style={{ display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}
                        >
                          {count}
                          {warn && (
                            <AlertTriangle
                              size={11}
                              aria-label={missing.length > 0 ? `Missing stock: ${missing.join(", ")}` : "No recipe"}
                              style={{ color: "var(--warn)" }}
                            />
                          )}
                        </span>
                      );
                    },
                  },
                  {
                    key: "usage",
                    label: "Used in",
                    width: 150,
                    render: (p) => (
                      // nowrap + ellipsis: the long count used to wrap under
                      // the row-action icons in the fixed table layout.
                      // Short labels so the whole line fits the column instead
                      // of being cut off; the exact wording stays in the
                      // tooltip.
                      <span
                        className="muted small"
                        style={{
                          display: "block",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                        title={`${p.recipeCount} recipe(s)`}
                      >
                        {p.recipeCount} {p.recipeCount === 1 ? "recipe" : "recipes"}
                      </span>
                    ),
                  },
                  {
                    key: "actions",
                    label: "",
                    width: 168,
                    align: "right",
                    render: (p) => p.active === false ? (
                      <div className="flex items-center justify-end gap-1">
                        <button
                          className="ghost small-btn"
                          onClick={() => setArchiving({ product: p, toActive: true })}
                          title="Unarchive product"
                        >
                          <ArchiveRestore size={13} />
                        </button>
                        <button
                          className="danger-ghost small-btn"
                          onClick={() => setDeleting(p)}
                          title="Delete product"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center justify-end gap-1">
                        <button
                          className="ghost small-btn"
                          onClick={() => openEdit(p)}
                          title="Edit price and recipe"
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
                          onClick={() => setArchiving({ product: p, toActive: false })}
                          title="Archive product (hide from POS)"
                        >
                          <Archive size={13} />
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
                rowClassName={(product) => product.active === false ? "product-row-archived" : ""}
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

                {productImageField({
                  draft: newProduct.imageDraft,
                  existingUrl: null,
                  onInsert: () => openCrop("add"),
                  onRemove: handleRemoveDraft,
                })}

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
                  <span>Recipe — ingredients deducted per unit sold</span>
                  {flatRecipesEditor(addRecipeRows, setAddRecipeRows)}
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

                {productImageField({
                  draft: editing?.imageDraft,
                  existingUrl: editing?.imageUrl,
                  onInsert: () => openCrop("edit"),
                  onRemove: handleRemoveImage,
                })}

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
                  <span>Recipe — ingredients deducted per unit sold</span>
                  {flatRecipesEditor(editing?.recipeLines ?? [], (updater) =>
                    setEditing((prev) => {
                      if (!prev) return prev;
                      const next = typeof updater === "function" ? updater(prev.recipeLines ?? []) : updater;
                      return { ...prev, recipeLines: next };
                    })
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

        {/* PRODUCT PHOTO INSERT / CROP (mounted per open, so it starts fresh) */}
        {cropState.open && (
          <ImageCropDialog
            seed={
              cropState.target === "add"
                ? (newProduct.imageDraft?.dataUrl ?? null)
                : (editing?.imageDraft?.dataUrl ?? editing?.imageUrl ?? null)
            }
            onCancel={() => setCropState({ open: false, target: null })}
            onSave={handleCropSave}
          />
        )}

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