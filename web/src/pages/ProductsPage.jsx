import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { Plus, Edit2, Trash2, X, Tag, AlertTriangle, Archive, ArchiveRestore, Star, ImagePlus } from "lucide-react";
import api from "../api.js";
import { getFriendlyError } from "../utils/errors.js";
import DataTable from "../components/DataTable.jsx";
import EmptyState from "../components/EmptyState.jsx";
import ErrorBox from "../components/ErrorBox.jsx";
import ConfirmDialog from "../components/ConfirmDialog.jsx";
import ImageCropDialog from "../components/ImageCropDialog.jsx";
import PageErrorBoundary from "../components/PageErrorBoundary.jsx";
import PageHeader from "../components/PageHeader.jsx";
import Select from "../components/Select.jsx";
import { useToast } from "../components/Toast.jsx";
import { LIVE_EVENTS, useLiveEvent } from "../hooks/useLiveStream.js";
import { useCatalogVersion } from "../hooks/useCatalogVersion.js";
import { sanitizeMoneyInput, sanitizeQtyInput, parseMoney, parseQty } from "../utils/format.js";
import { sanitizeTextInput, validateItemName, countLetters } from "../utils/text.js";

let recipeRowSeq = 1;
let flavorRowSeq = 1;

function newRecipeRowState(overrides = {}) {
  return {
    key: `rr-${Date.now()}-${recipeRowSeq++}`,
    itemName: "",
    amount: "",
    unit: "",
    ...overrides,
  };
}

function newestProductsFirst(products) {
  return [...products].sort((a, b) => Number(b.id) - Number(a.id));
}

// The fingerprint of the catalog as this app last saw it.
//
// It is module level on purpose: a ref read inside the load callback trips
// the react-hooks/refs rule ("cannot access refs during render"), because the
// compiler cannot prove the callback never runs during a render. The value is
// a cache of the last response, not render state, so it belongs here.
let lastCatalogSignature = "";

// A cheap fingerprint of the catalog: prices, sizes, recipes and the archived
// flag. A live reload that returns the SAME fingerprint means nothing really
// changed (our own save, most of the time), so the owner does not get a
// pointless "Menu updated" toast.
function catalogSignature(list) {
  return JSON.stringify(
    (list ?? []).map((p) => [
      p.id,
      p.name,
      p.basePrice,
      p.active !== false ? 1 : 0,
      (p.flavors ?? []).map((f) => [
        f.name,
        f.unitPrice ?? null,
        (f.recipes ?? []).map((r) => [r.itemName, r.amountPerUnit]),
      ]),
      (p.recipes ?? []).map((r) => [r.itemName, r.amountPerUnit]),
    ])
  );
}

function marginPercent(cost, selling) {
  const c = Number(cost);
  const s = Number(selling);
  if (cost === null || cost === undefined || cost === "" || !Number.isFinite(c)) return "—";
  if (!Number.isFinite(s) || s <= 0) return "—";
  return `${(((s - c) / s) * 100).toFixed(1)}%`;
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
  const [newProduct, setNewProduct] = useState({ name: "", category: "Fries", cost: "", markupPrice: "", sellingPrice: "", imageDraft: null });
  const [addFlavorRows, setAddFlavorRows] = useState([]);

  const [cropState, setCropState] = useState({ open: false, target: null });
  const [starring, setStarring] = useState(null);

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

  // Archived products stay in the database for history, but they would bury
  // the live catalog (the old per-size fries products are archived). Default
  // to hiding them; the toggle brings them back.
  const [showArchived, setShowArchived] = useState(false);

  // `quiet` skips the loading state (a live refresh must not flash the
  // table's skeleton). Resolves to true when the catalog actually changed.
  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    try {
      const [p, n] = await Promise.all([
        api.get("/products"),
        api.get("/inventory/names").catch(() => ({ data: { data: [] } })),
      ]);
      const next = newestProductsFirst(p.data?.data ?? []);
      const signature = catalogSignature(next);
      const changed = signature !== lastCatalogSignature;
      lastCatalogSignature = signature;
      setProducts(next);
      setItemNames(n.data?.data ?? []);
      setError("");
      return changed;
    } catch (err) {
      setError(getFriendlyError(err, "Unable to load products."));
      return false;
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(timer);
  }, [load]);

  // Archived products (history only, hidden from the POS) are collapsed by
  // default so the live catalog stays readable.
  const archivedCount = products.filter((p) => p.active === false).length;
  const visibleProducts = showArchived
    ? products
    : products.filter((p) => p.active !== false);

  const isAnyModalOpen = addOpen || addClosing || editing || editClosing ||
    renaming || renameClosing || Boolean(deleting);

  useEffect(() => {
    if (isAnyModalOpen) document.body.style.overflow = "hidden";
    else document.body.style.overflow = "";
    return () => { document.body.style.overflow = ""; };
  }, [isAnyModalOpen]);

  // Live catalog updates: another device (or another tab) changed the menu -
  // a price, a recipe, a size, a photo - so refresh the list instead of
  // waiting for a manual reload.
  //
  // Two sources, on purpose:
  //   - the SSE frame ("product:updated") arrives within seconds, but the
  //     stream is paused while the tab is hidden, so it can miss changes;
  //   - the catalog-version probe covers exactly that gap (and the case where
  //     the stream is down).
  //
  // A modal that is open keeps its own snapshot: the refresh waits until it
  // closes, so a form never shows a half-updated table underneath it.
  const liveTimer = useRef(null);
  const livePending = useRef(false);
  const applyLiveUpdate = useCallback(async () => {
    if (isAnyModalOpen) {
      livePending.current = true;
      return;
    }
    const changed = await load({ quiet: true });
    if (changed) toast("Menu updated", "info");
  }, [isAnyModalOpen, load, toast]);
  const scheduleLiveUpdate = useCallback(() => {
    if (liveTimer.current) clearTimeout(liveTimer.current);
    liveTimer.current = setTimeout(() => {
      liveTimer.current = null;
      void applyLiveUpdate();
    }, 500);
  }, [applyLiveUpdate]);
  useLiveEvent(LIVE_EVENTS.productUpdated, scheduleLiveUpdate);
  useCatalogVersion(scheduleLiveUpdate);
  useEffect(() => () => {
    if (liveTimer.current) clearTimeout(liveTimer.current);
  }, []);
  // A live update that landed while a modal was open is applied now.
  useEffect(() => {
    if (isAnyModalOpen || !livePending.current) return;
    livePending.current = false;
    void applyLiveUpdate();
  }, [isAnyModalOpen, applyLiveUpdate]);

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

  // Pricing model:
  //   cost         - what the item costs the stall (stored on the product)
  //   markupPrice  - the tubo, derived from cost and selling price
  //   sellingPrice - what the POS charges (stored as `basePrice` on the server)
  // Changing the COST never changes the selling price; changing the markup or
  // the selling price does.
  const handleAddPriceChange = (field, val) => {
    setNewProduct(prev => {
      const next = { ...prev, [field]: val };
      const cost = parseFloat(next.cost || 0);
      const markup = parseFloat(next.markupPrice || 0);
      const selling = parseFloat(next.sellingPrice || 0);

      if (field === 'cost') {
        // Selling price stays; only the markup follows the cost.
        next.markupPrice = selling > 0 ? (selling - cost).toFixed(2) : "";
      } else if (field === 'markupPrice') {
        next.sellingPrice = cost + markup > 0 ? (cost + markup).toFixed(2) : "";
      } else if (field === 'sellingPrice') {
        next.markupPrice = selling - cost >= 0 ? (selling - cost).toFixed(2) : "";
      }
      return next;
    });
  };

  const handleEditPriceChange = (field, val) => {
    setEditing(prev => {
      const next = { ...prev, [field]: val };
      const cost = parseFloat(next.cost || 0);
      const markup = parseFloat(next.markupPrice || 0);
      const selling = parseFloat(next.sellingPrice || 0);

      if (field === 'cost') {
        next.markupPrice = selling > 0 ? (selling - cost).toFixed(2) : "";
      } else if (field === 'markupPrice') {
        next.sellingPrice = cost + markup > 0 ? (cost + markup).toFixed(2) : "";
      } else if (field === 'sellingPrice') {
        next.markupPrice = selling - cost >= 0 ? (selling - cost).toFixed(2) : "";
      }
      return next;
    });
  };

  function updateRecipeLineFlat(setLines, key, patch) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function addFlavorRow() {
    setAddFlavorRows((prev) => {
      // Each flavor/size owns its full recipe. A new row starts from the
      // product's shared/starter recipe (the packs + powder every size uses),
      // minus any pouch because the pouch is what changes per size. A
      // flavor-specific powder (Cheese vs BBQ) is never copied across.
      const template = addRecipeRows.filter(
        (r) => !/^pouch/i.test(String(r.itemName ?? "").trim())
      );
      return [
        ...prev,
        {
          key: `flavor-${Date.now()}-${flavorRowSeq++}`,
          name: "",
          recipeRows: template.map((r) =>
            newRecipeRowState({ itemName: r.itemName, amount: r.amount, unit: r.unit })
          ),
          recipeOpen: true,
        },
      ];
    });
  }

  // A stored recipe amount is in the stock item's base unit (kg, packs, pcs).
  // The editor shows mass in grams by default, so convert it for display and
  // remember the display unit; the save converts it back via toStockUnit.
  function recipeRowFromStored(r) {
    const itemName = String(r.itemName ?? "");
    const storedAmount = Number(r.amountPerUnit) || 0;
    const stockUnit = itemNames.find(
      (n) => n.name.toLowerCase() === itemName.trim().toLowerCase()
    )?.unit ?? "";
    const displayUnit = defaultUnitFor(stockUnit);
    const rate = MASS_TO_KG[String(displayUnit).toLowerCase()];
    const storedRate = MASS_TO_KG[String(stockUnit).toLowerCase()];
    const displayAmount =
      rate !== undefined && storedRate !== undefined
        ? Math.round((storedAmount / rate) * 1e6) / 1e6
        : storedAmount;
    return newRecipeRowState({
      itemName,
      amount: String(displayAmount),
      unit: displayUnit,
    });
  }

  function flatRecipesEditor(lines, setLines, listId = "cartiq-inventory-items") {
    const knownItems = new Set(itemNames.map((n) => n.name.toLowerCase()));
    const knownUnitOf = (name) =>
      itemNames.find((n) => n.name.toLowerCase() === String(name ?? "").trim().toLowerCase())?.unit ?? "";

    return (
      <div className="flex flex-col gap-3">
        <datalist id={listId}>
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
                  list={listId}
                  title="Must match a stock item name exactly - pick from the list"
                  value={line.itemName}
                  onChange={(e) =>
                    updateRecipeLineFlat(setLines, line.key, { itemName: sanitizeTextInput(e.target.value, 120) })
                  }
                />
                <input
                  type="number"
                  min="0"
                  step="any"
                  placeholder="Qty"
                  title={`Amount deducted per unit sold, in ${effUnit}`}
                  value={line.amount}
                  onChange={(e) =>
                    updateRecipeLineFlat(setLines, line.key, { amount: sanitizeQtyInput(e.target.value) })
                  }
                />
                <Select
                  ariaLabel="Unit"
                  className="product-recipe-unit-select"
                  title={stockUnit ? `Stock unit is ${stockUnit} - converts automatically` : "Pick the unit"}
                  value={effUnit}
                  onChange={(unit) => updateRecipeLineFlat(setLines, line.key, { unit })}
                  options={unitChoices.map((unit) => ({ value: unit, label: unit }))}
                />
                <button
                  type="button"
                  className="danger-ghost small-btn product-recipe-remove"
                  title="Remove recipe line"
                  onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
                >
                  <X size={14} strokeWidth={2.5} aria-hidden="true" />
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
    const seenItems = new Set();
    const stockUnitOf = (name) =>
      itemNames.find((n) => n.name.toLowerCase() === String(name ?? "").trim().toLowerCase())?.unit ?? "";

    for (const r of lines) {
      const itemName = String(r.itemName ?? "").trim();
      const rawAmount = parseQty(String(r.amount ?? ""));

      if (!itemName && rawAmount === null) continue;

      if (!itemName || itemName.length > 120) {
        return { ok: false, error: "Recipe lines need an item name (max 120 characters)." };
      }
      if (countLetters(itemName) < 2) {
        return { ok: false, error: `Recipe ingredient "${itemName}" needs at least 2 letters.` };
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
      
      const itemKey = itemName.toLowerCase();
      if (seenItems.has(itemKey)) {
        return { ok: false, error: `Recipe item "${itemName}" can only appear once per recipe.` };
      }
      seenItems.add(itemKey);
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

    const cat = newProduct.category.trim();
    if (cat && countLetters(cat) < 2) {
      setAddError("Category needs at least 2 letters.");
      return;
    }
    const finalCategory = cat || "Fries";

    if (newProduct.cost !== "" && parseMoney(newProduct.cost) === null) {
      setAddError("Cost must be a valid number.");
      return;
    }
    if (newProduct.markupPrice !== "" && parseMoney(newProduct.markupPrice) === null) {
      setAddError("Markup (Tubo) must be a valid number.");
      return;
    }

    const sp = parseMoney(newProduct.sellingPrice);
    if (sp === null || sp <= 0) {
      setAddError("Selling price must be valid and greater than zero.");
      return;
    }
    const cost = newProduct.cost === "" ? null : parseMoney(newProduct.cost);
    if (cost !== null && cost > sp) {
      setAddError("Cost cannot be higher than the selling price.");
      return;
    }

    const checked = checkFlatRecipes(addRecipeRows);
    if (!checked.ok) {
      setAddError(checked.error);
      return;
    }

    const checkedFlavors = [];
    const seenFlavors = new Set();
    for (const row of addFlavorRows) {
      const flavorName = String(row.name ?? "").trim();
      const hasAnyValue = flavorName || (row.recipeRows ?? []).length > 0;
      if (!hasAnyValue) continue;

      if (flavorName.length > 60) {
        setAddError("Each flavor needs a name (max 60 characters).");
        return;
      }
      if (countLetters(flavorName) < 2) {
        setAddError(`Flavor "${flavorName}" needs at least 2 letters.`);
        return;
      }
      
      const flavorKey = flavorName.toLowerCase();
      if (seenFlavors.has(flavorKey)) {
        setAddError(`Flavor "${flavorName}" is listed more than once.`);
        return;
      }
      seenFlavors.add(flavorKey);

      const flavorRecipes = checkFlatRecipes(row.recipeRows ?? []);
      if (!flavorRecipes.ok) {
        setAddError(`${flavorName}: ${flavorRecipes.error}`);
        return;
      }
      checkedFlavors.push({ name: flavorName, recipes: flavorRecipes.recipes });
    }

    if (checkedFlavors.length > 20) {
      setAddError("A product can have at most 20 flavors.");
      return;
    }

    setIsAdding(true);
    try {
      const { data } = await api.post("/products", {
        name: name.value,
        category: finalCategory,
        basePrice: sp,
        ...(cost !== null ? { cost } : {}),
        ...(checkedFlavors.length > 0 ? { flavors: checkedFlavors } : {}),
      });

      const newId = data?.product?.id;
      // Products with flavors store a complete recipe under each size (the
      // add-flavor action copies the starter recipe into each new row).
      // Products without flavors keep their recipe on the product itself.
      if (newId && checked.recipes.length > 0 && checkedFlavors.length === 0) {
        try {
          await api.patch(`/products/${newId}`, {
            addRecipes: checked.recipes.map((r) => ({ flavor: "", ...r })),
          });
        } catch (recErr) {
          toast(getFriendlyError(recErr, "Product created but its recipe lines could not be saved — open Edit and save them again."), "error");
        }
      }

      if (newProduct.imageDraft && data?.product?.id) {
        try {
          await uploadProductImage(data.product.id, newProduct.imageDraft);
        } catch (imgErr) {
          toast(getFriendlyError(imgErr, "Product created, but the photo upload failed."), "error");
        }
      }

      const recipeNote = checked.recipes.length && checkedFlavors.length === 0
        ? ` and ${checked.recipes.length} recipe line(s)`
        : "";
      toast(
        `Product "${name.value}" created${checkedFlavors.length ? ` with ${checkedFlavors.length} flavor(s), each with its own recipe` : ""}${recipeNote}`,
        "success"
      );
      closeAddModal();
      setNewProduct({ name: "", category: "Fries", cost: "", markupPrice: "", sellingPrice: "", imageDraft: null });
      setAddRecipeRows([]);
      setAddFlavorRows([]);
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

    const cat = editing.category.trim();
    if (cat && countLetters(cat) < 2) {
      setEditError("Category needs at least 2 letters.");
      return;
    }
    const finalCategory = cat || "Fries";

    if (editing.cost !== "" && editing.cost !== undefined && parseMoney(editing.cost) === null) {
      setEditError("Cost must be a valid number.");
      return;
    }
    if (editing.markupPrice !== "" && parseMoney(editing.markupPrice) === null) {
      setEditError("Markup (Tubo) must be a valid number.");
      return;
    }

    const sp = parseMoney(editing.sellingPrice);
    if (sp === null || sp <= 0) {
      setEditError("Selling price must be valid and greater than zero.");
      return;
    }
    const editCost = editing.cost === "" || editing.cost === undefined ? null : parseMoney(editing.cost);
    if (editCost !== null && editCost > sp) {
      setEditError("Cost cannot be higher than the selling price.");
      return;
    }

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

    const checkedFlavors = [];
    const seenFlavors = new Set();
    for (const row of (editing.flavorRows ?? [])) {
      const flavorName = String(row.name ?? "").trim();
      const hasAnyValue = flavorName || (row.recipeRows ?? []).length > 0;
      if (!hasAnyValue) continue;

      if (flavorName.length > 60) {
        setEditError("Each flavor needs a name (max 60 characters).");
        return;
      }
      if (countLetters(flavorName) < 2) {
        setEditError(`Flavor "${flavorName}" needs at least 2 letters.`);
        return;
      }
      
      const flavorKey = flavorName.toLowerCase();
      if (seenFlavors.has(flavorKey)) {
        setEditError(`Flavor "${flavorName}" is listed more than once.`);
        return;
      }
      seenFlavors.add(flavorKey);
      
      const flavorRecipes = checkFlatRecipes(row.recipeRows ?? []);
      if (!flavorRecipes.ok) {
        setEditError(`${flavorName}: ${flavorRecipes.error}`);
        return;
      }
      checkedFlavors.push({ name: flavorName, recipes: flavorRecipes.recipes, _baseline: row._baseline ?? [] });
    }

    if (checkedFlavors.length > 20) {
      setEditError("A product can have at most 20 flavors.");
      return;
    }

    for (const f of checkedFlavors) {
      const fKeptNames = new Set(f.recipes.map((r) => r.itemName));
      const fUnchanged =
        f.recipes.length === f._baseline.length &&
        f.recipes.every((r) => f._baseline.some((b) => keepPair(r, b)));

      if (!fUnchanged) {
        const fRemove = f._baseline.filter((b) => !fKeptNames.has(b.itemName)).map((b) => ({ flavor: f.name, itemName: b.itemName }));
        const fAdd = f.recipes.map((r) => ({ flavor: f.name, ...r }));
        removeRecipes.push(...fRemove);
        addRecipes.push(...fAdd);
      }
    }

    const hasImageDraft = Boolean(editing.imageDraft);
    
    const originalFlavorNames = (editing.flavors || []).map(f => f.name).join("|");
    const newFlavorNames = checkedFlavors.map(f => f.name).join("|");
    const flavorNamesChanged = originalFlavorNames !== newFlavorNames;

    if (
      finalCategory === (editing._category || "Fries") &&
      sp === Number(editing._sellingPrice) &&
      editCost === editing._cost &&
      !hasImageDraft &&
      !flavorNamesChanged &&
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
        category: finalCategory,
        basePrice: sp,
        cost: editCost,
        flavors: checkedFlavors.map(f => ({ name: f.name, recipes: f.recipes }))
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
      
      if (finalCategory !== (editing._category || "Fries")) details.push("category updated");
      if (sp !== Number(editing._sellingPrice)) details.push(`selling price P${Number(editing._sellingPrice)} → P${sp}`);
      if ((data?.flavorsChanged ?? 0) > 0) details.push(`${data.flavorsChanged} flavor(s) updated`);
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
      const { data } = await api.del(`/products/${deleting.id}`);
      const removedRows = Number(data?.removedRecipeRows ?? 0);
      toast(
        `Product "${deleting.name}" deleted` +
          (removedRows > 0 ? ` (${removedRows} recipe row(s) removed)` : ""),
        "success"
      );
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
    // The stored cost (what the stall pays). Null when it was never set - the
    // margin then reads "—" instead of a fake 0%.
    const costSnapshot = p.cost === null || p.cost === undefined ? null : Number(p.cost);
    const hasCost = costSnapshot !== null && Number.isFinite(costSnapshot);
    
    const flatRecipes = (p.recipes ?? []).map(recipeRowFromStored);

    // Rows still stored on the product (flavor "") apply to every size. Fold
    // them into each size's recipe so the panel shows the real deduction and
    // the first save keeps a copy per size. A flavor-specific row always wins.
    const baseRecipeLines = (p.recipes ?? []).map((r) => ({
      itemName: String(r.itemName ?? "").trim(),
      amountPerUnit: Number(r.amountPerUnit) || 0,
    }));

    const mappedFlavors = (p.flavors ?? []).map((f) => {
      const ownRows = (f.recipes ?? []).map(recipeRowFromStored);
      const ownNames = new Set(
        ownRows.map((r) => String(r.itemName ?? "").trim().toLowerCase())
      );
      const inherited = baseRecipeLines
        .filter((r) => r.itemName && !ownNames.has(r.itemName.toLowerCase()))
        .map((r) => recipeRowFromStored({ itemName: r.itemName, amountPerUnit: r.amountPerUnit }));
      return {
        key: `flavor-${Date.now()}-${flavorRowSeq++}`,
        id: f.id,
        name: f.name,
        recipeOpen: true,
        recipeRows: [...ownRows, ...inherited],
        _baseline: (f.recipes ?? []).map((r) => ({
          itemName: String(r.itemName ?? ""),
          amountPerUnit: Number(r.amountPerUnit) || 0
        }))
      };
    });

    setEditing({
      ...p,
      category: p.category || "Fries",
      cost: hasCost ? String(costSnapshot) : "",
      markupPrice: hasCost
        ? String(Math.max(0, sellingPriceSnapshot - costSnapshot))
        : "",
      sellingPrice: String(sellingPriceSnapshot),
      imageUrl: p.imageUrl ?? "",
      imageDraft: null,
      recipeLines: flatRecipes,
      flavorRows: mappedFlavors,
      _recipeBaseline: (p.recipes ?? []).map((r) => ({
        itemName: String(r.itemName ?? ""),
        amountPerUnit: Number(r.amountPerUnit) || 0,
      })),
      _category: p.category || "Fries",
      _cost: hasCost ? costSnapshot : null,
      _basePrice: basePriceSnapshot,
      _markupPrice: hasCost ? Math.max(0, sellingPriceSnapshot - costSnapshot) : null,
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
      <div className="page-container wide products-page">
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
                  setAddFlavorRows([]);
                  setAddOpen(true);
                }}
              >
                <Plus size={14} /> Add product
              </button>
              {archivedCount > 0 && (
                <button
                  type="button"
                  className="ghost small-btn"
                  onClick={() => setShowArchived((v) => !v)}
                  title={`${archivedCount} archived product(s) - hidden from the POS`}
                >
                  {showArchived ? "Hide archived" : `Show archived (${archivedCount})`}
                </button>
              )}
            </>
          }
        />

        <section className="panel sales-panel products-panel">
          {error ? (
            <ErrorBox message={error} onRetry={load} />
          ) : !loading && visibleProducts.length === 0 ? (
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
                    width: "23%",
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
                        <span className="product-mobile-price muted small">
                          — P{Number(p.sellingPrice ?? p.basePrice ?? 0).toLocaleString()}
                        </span>
                      </span>
                    ),
                  },
                  {
                    key: "category",
                    label: "Category",
                    width: "12%",
                    render: (p) => <span className="muted">{p.category}</span>,
                  },
                  {
                    key: "flavors",
                    label: "Flavor/Variants",
                    width: "31%",
                    render: (p) => {
                      const flavors = p.flavors ?? [];
                      if (flavors.length === 0) return <span className="muted">—</span>;
                      return (
                        <div className="product-flavor-list" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          {flavors.map((flavor) => (
                            <div
                              key={flavor.id ?? flavor.name}
                              className="product-flavor-item"
                              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}
                            >
                              <span className="product-flavor-label">
                                {flavor.name}
                                <span className="muted small"> — P{Number(flavor.unitPrice ?? p.basePrice ?? 0).toLocaleString()}</span>
                              </span>
                            </div>
                          ))}
                        </div>
                      );
                    },
                  },
                  {
                    key: "sellingPrice",
                    label: "Price",
                    width: "11%",
                    align: "right",
                    render: (p) => <strong>P{Number(p.sellingPrice ?? p.basePrice ?? 0).toLocaleString()}</strong>,
                  },
                  {
                    key: "recipes",
                    label: "Recipes",
                    width: "10%",
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
                    key: "actions",
                    label: "Actions",
                    width: "13%",
                    align: "center",
                    render: (p) => p.active === false ? (
                      <div className="product-actions flex items-center justify-end gap-1">
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
                      <div className="product-actions flex items-center justify-end gap-1">
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
                data={visibleProducts}
                rowClassName={(product) => product.active === false ? "product-row-archived" : ""}
              />
            </>
          )}
        </section>

        {/* ADD PRODUCT MODAL */}
        {(addOpen || addClosing) && (
          <div className={`modal-backdrop ${addClosing ? "is-closing" : ""}`}>
            <div
              className={`modal modal--tall product-modal ${addClosing ? "is-closing" : ""}`}
              role="dialog"
              aria-modal="true"
              aria-labelledby="add-product-title"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="product-modal-header">
                <span className="product-modal-icon" aria-hidden="true"><Plus size={20} /></span>
                <div>
                  <h3 id="add-product-title">Add Product</h3>
                  <p className="muted">Create a catalog item and set its pricing and ingredients.</p>
                </div>
              </div>

              <form onSubmit={handleAddProduct} className="product-modal-form">
                <section className="product-modal-section">
                  <div className="product-modal-section-heading">
                    <h4>Product details</h4>
                    <span>Basic information shown in the POS catalog</span>
                  </div>
                <div className="product-modal-fields product-modal-fields--two">
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
                </section>

                <section className="product-modal-section">
                  {productImageField({
                    draft: newProduct.imageDraft,
                    existingUrl: null,
                    onInsert: () => openCrop("add"),
                    onRemove: handleRemoveDraft,
                  })}
                </section>

                <section className="product-modal-section">
                  <div className="product-modal-section-heading">
                    <h4>Pricing</h4>
                    <span>Cost is what the stall pays; the selling price is what the POS charges.</span>
                  </div>
                <div className="product-modal-fields product-modal-fields--pricing">
                  <label className="field">
                    Cost
                    <input
                      type="number"
                      min="0"
                      max="9999999.99"
                      step="0.01"
                      placeholder="optional"
                      title="What the item costs the stall. Leave empty if unknown."
                      value={newProduct.cost ?? ""}
                      onChange={(e) => handleAddPriceChange("cost", sanitizeMoneyInput(e.target.value))}
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
                  <label className="field product-modal-selling-price">
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
                <p className="muted small" aria-live="polite" style={{ margin: "10px 0 0" }}>
                  Margin: {marginPercent(newProduct.cost, newProduct.sellingPrice)}
                </p>
                </section>
                
                <section className="product-modal-section">
                  <div className="product-modal-section-heading">
                    <h4>Flavor/Variants</h4>
                    <span>Each size/flavor has its own recipe — the pouch, packs and powder are deducted only for that size.</span>
                  </div>
                  <div className="flex flex-col gap-3">
                    {addFlavorRows.map((row, index) => (
                      <div
                        key={row.key}
                        style={{
                          padding: 12,
                          border: "1px solid var(--border)",
                          borderRadius: 12,
                          display: "flex",
                          flexDirection: "column",
                          gap: 10,
                        }}
                      >
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "minmax(120px, 1fr) auto auto",
                            alignItems: "end",
                            gap: 8,
                          }}
                        >
                          <label className="field">
                            Flavor name
                            <input
                              type="text"
                              maxLength={60}
                              placeholder="e.g. Cheese"
                              value={row.name}
                              onChange={(e) => setAddFlavorRows((prev) => prev.map((item) =>
                                item.key === row.key
                                  ? { ...item, name: sanitizeTextInput(e.target.value, 60) }
                                  : item
                              ))}
                            />
                          </label>
                          <button
                            type="button"
                            className="ghost small-btn"
                            onClick={() => setAddFlavorRows((prev) => prev.map((item) =>
                              item.key === row.key ? { ...item, recipeOpen: !item.recipeOpen } : item
                            ))}
                            aria-expanded={row.recipeOpen}
                          >
                            <Edit2 size={13} /> {row.recipeOpen ? "Hide recipe" : "Edit recipe"}
                          </button>
                          <button
                            type="button"
                            className="danger-ghost small-btn"
                            title={`Remove flavor ${index + 1}`}
                            aria-label={`Remove flavor ${index + 1}`}
                            onClick={() => setAddFlavorRows((prev) => prev.filter((item) => item.key !== row.key))}
                          >
                            <X size={14} />
                          </button>
                        </div>

                        {row.recipeOpen && (
                          <section
                            aria-label={`${row.name || `Flavor ${index + 1}`} recipe`}
                            style={{
                              padding: 12,
                              border: "1px solid var(--border)",
                              borderRadius: 10,
                              background: "var(--surface-alt)",
                            }}
                          >
                            <h5 style={{ margin: "0 0 10px" }}>{row.name || `Flavor ${index + 1}`} recipe</h5>
                            {flatRecipesEditor(
                              row.recipeRows,
                              (updater) => setAddFlavorRows((prev) => prev.map((item) => {
                                if (item.key !== row.key) return item;
                                const next = typeof updater === "function" ? updater(item.recipeRows) : updater;
                                return { ...item, recipeRows: next };
                              })),
                              `cartiq-inventory-items-${row.key}`
                            )}
                          </section>
                        )}
                      </div>
                    ))}

                    <button
                      type="button"
                      className="ghost small-btn"
                      style={{ alignSelf: "flex-start" }}
                      onClick={addFlavorRow}
                      disabled={addFlavorRows.length >= 20}
                    >
                      <Plus size={13} /> Add flavor/variant
                    </button>
                  </div>
                </section>

                {addFlavorRows.length === 0 && (
                  <section className="product-modal-section product-modal-recipe">
                    <div className="product-modal-section-heading">
                      <h4>Recipe</h4>
                      <span>Ingredients deducted per unit sold. Add flavors above and each one gets its own copy of this recipe.</span>
                    </div>
                    {flatRecipesEditor(addRecipeRows, setAddRecipeRows)}
                  </section>
                )}
                
                <div className="product-modal-footer">
                  {addError && <p className="error-box" role="alert">{addError}</p>}
                  <div className="modal-actions">
                    <button type="button" className="ghost" onClick={closeAddModal} disabled={isAdding || addClosing}>Cancel</button>
                    <button type="submit" disabled={isAdding || addClosing}>
                      {isAdding ? "Creating..." : "Create Product"}
                    </button>
                  </div>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* EDIT PRODUCT MODAL */}
        {(editing || editClosing) && (
          <div className={`modal-backdrop ${editClosing ? "is-closing" : ""}`}>
            <div
              className={`modal modal--tall product-modal ${editClosing ? "is-closing" : ""}`}
              role="dialog"
              aria-modal="true"
              aria-labelledby="edit-product-title"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="product-modal-header">
                <span className="product-modal-icon" aria-hidden="true"><Edit2 size={18} /></span>
                <div>
                  <h3 id="edit-product-title">Edit {editing?.name}</h3>
                  <p className="muted">Update catalog details, pricing, and ingredients.</p>
                </div>
              </div>
              
              <form onSubmit={handleEditProduct} className="product-modal-form">
                <p className="product-modal-note">Price changes apply to future sales only. Recorded orders keep their original totals.</p>

                <section className="product-modal-section">
                  <div className="product-modal-section-heading">
                    <h4>Product details</h4>
                  </div>
                  <div className="product-modal-fields product-modal-fields--two">
                    <label className="field">
                      Category
                      <input
                        type="text"
                        maxLength={60}
                        value={editing?.category || ""}
                        onChange={(e) => setEditing({ ...editing, category: e.target.value })}
                      />
                    </label>
                  </div>
                </section>

                <section className="product-modal-section">
                  {productImageField({
                    draft: editing?.imageDraft,
                    existingUrl: editing?.imageUrl,
                    onInsert: () => openCrop("edit"),
                    onRemove: handleRemoveImage,
                  })}
                </section>

                <section className="product-modal-section">
                  <div className="product-modal-section-heading">
                    <h4>Pricing</h4>
                    <span>Cost is what the stall pays; the selling price is what the POS charges.</span>
                  </div>
                <div className="product-modal-fields product-modal-fields--pricing">
                  <label className="field">
                    Cost
                    <input
                      type="number"
                      min="0"
                      max="9999999.99"
                      step="0.01"
                      placeholder="optional"
                      title="What the item costs the stall. Leave empty if unknown."
                      value={editing?.cost ?? ""}
                      onChange={(e) => handleEditPriceChange("cost", sanitizeMoneyInput(e.target.value))}
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
                  <label className="field product-modal-selling-price">
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
                <p className="muted small" aria-live="polite" style={{ margin: "10px 0 0" }}>
                  Margin: {marginPercent(editing?.cost, editing?.sellingPrice)}
                </p>
                </section>
                
                <section className="product-modal-section">
                  <div className="product-modal-section-heading">
                    <h4>Flavor/Variants</h4>
                    <span>Each size/flavor has its own recipe — the pouch, packs and powder are deducted only for that size.</span>
                  </div>
                  <div className="flex flex-col gap-3">
                    {(editing?.flavorRows ?? []).map((row, index) => (
                      <div
                        key={row.key}
                        style={{
                          padding: 12,
                          border: "1px solid var(--border)",
                          borderRadius: 12,
                          display: "flex",
                          flexDirection: "column",
                          gap: 10,
                        }}
                      >
                        <div style={{ display: "grid", gridTemplateColumns: "minmax(120px, 1fr) auto auto", alignItems: "end", gap: 8 }}>
                          <label className="field">
                            Flavor name
                            <input
                              type="text"
                              maxLength={60}
                              placeholder="e.g. Cheese"
                              value={row.name}
                              onChange={(e) =>
                                setEditing((prev) => ({
                                  ...prev,
                                  flavorRows: prev.flavorRows.map((item) =>
                                    item.key === row.key ? { ...item, name: sanitizeTextInput(e.target.value, 60) } : item
                                  ),
                                }))
                              }
                            />
                          </label>
                          <button
                            type="button"
                            className="ghost small-btn"
                            onClick={() =>
                              setEditing((prev) => ({
                                ...prev,
                                flavorRows: prev.flavorRows.map((item) =>
                                  item.key === row.key ? { ...item, recipeOpen: !item.recipeOpen } : item
                                ),
                              }))
                            }
                            aria-expanded={row.recipeOpen}
                          >
                            <Edit2 size={13} /> {row.recipeOpen ? "Hide recipe" : "Edit recipe"}
                          </button>
                          <button
                            type="button"
                            className="danger-ghost small-btn"
                            title={`Remove flavor ${index + 1}`}
                            aria-label={`Remove flavor ${index + 1}`}
                            onClick={() =>
                              setEditing((prev) => ({
                                ...prev,
                                flavorRows: prev.flavorRows.filter((item) => item.key !== row.key),
                              }))
                            }
                          >
                            <X size={14} />
                          </button>
                        </div>
                        
                        {row.recipeOpen && (
                          <section
                            aria-label={`${row.name || `Flavor ${index + 1}`} recipe`}
                            style={{ padding: 12, border: "1px solid var(--border)", borderRadius: 10, background: "var(--surface-alt)" }}
                          >
                            <h5 style={{ margin: "0 0 10px" }}>{row.name || `Flavor ${index + 1}`} recipe</h5>
                            {flatRecipesEditor(
                              row.recipeRows,
                              (updater) =>
                                setEditing((prev) => ({
                                  ...prev,
                                  flavorRows: prev.flavorRows.map((item) => {
                                    if (item.key !== row.key) return item;
                                    const next = typeof updater === "function" ? updater(item.recipeRows) : updater;
                                    return { ...item, recipeRows: next };
                                  }),
                                })),
                              `cartiq-inventory-items-${row.key}`
                            )}
                          </section>
                        )}
                      </div>
                    ))}
                    <button
                      type="button"
                      className="ghost small-btn"
                      style={{ alignSelf: "flex-start" }}
                      onClick={() => {
                        setEditing((prev) => {
                          // Give the new size the product's shared/starter
                          // ingredients (packs + powder). The pouch is
                          // size-specific, and a flavor-specific powder must
                          // never be copied to another flavor.
                          const template = (prev.recipeLines ?? []).filter(
                            (r) => !/^pouch/i.test(String(r.itemName ?? "").trim())
                          );
                          return {
                            ...prev,
                            flavorRows: [
                              ...(prev.flavorRows || []),
                              {
                                key: `flavor-${Date.now()}-${flavorRowSeq++}`,
                                name: "",
                                recipeRows: template.map((r) =>
                                  newRecipeRowState({ itemName: r.itemName, amount: r.amount, unit: r.unit })
                                ),
                                recipeOpen: true,
                              },
                            ],
                          };
                        });
                      }}
                      disabled={(editing?.flavorRows?.length || 0) >= 20}
                    >
                      <Plus size={13} /> Add flavor/variant
                    </button>
                  </div>
                </section>

                {(editing?.flavorRows ?? []).length === 0 && (
                  <section className="product-modal-section product-modal-recipe">
                    <div className="product-modal-section-heading">
                      <h4>Recipe</h4>
                      <span>Ingredients deducted per unit sold</span>
                    </div>
                    {flatRecipesEditor(editing?.recipeLines ?? [], (updater) =>
                      setEditing((prev) => {
                        if (!prev) return prev;
                        const next = typeof updater === "function" ? updater(prev.recipeLines ?? []) : updater;
                        return { ...prev, recipeLines: next };
                      })
                    )}
                  </section>
                )}
                
                <div className="product-modal-footer">
                  {editError && <p className="error-box" role="alert">{editError}</p>}
                  <div className="modal-actions">
                    <button type="button" className="ghost" onClick={closeEditModal} disabled={isEditing || editClosing}>Cancel</button>
                    <button type="submit" disabled={isEditing || editClosing}>
                      {isEditing ? "Saving..." : "Save Changes"}
                    </button>
                  </div>
                </div>
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