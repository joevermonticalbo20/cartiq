import { useCallback, useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { Plus, Edit2, Trash2, RefreshCw, Tag } from "lucide-react";
import api, { getErrorMessage } from "../api.js";
import Badge from "../components/Badge.jsx";
import DataTable from "../components/DataTable.jsx";
import EmptyState from "../components/EmptyState.jsx";
import ConfirmDialog from "../components/ConfirmDialog.jsx";
import PageErrorBoundary from "../components/PageErrorBoundary.jsx";
import PageHeader from "../components/PageHeader.jsx";
import { useToast } from "../components/Toast.jsx";
import { sanitizeMoneyInput, parseMoney } from "../utils/format.js";
import { sanitizeTextInput, validateItemName } from "../utils/text.js";

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
  const [newProduct, setNewProduct] = useState({ name: "", category: "Fries", basePrice: "", flavorIds: [] });

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
      .catch((err) => setError(getErrorMessage(err, "Unable to load products.")))
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

  function toggleFlavor(list, id) {
    return list.includes(id) ? list.filter((f) => f !== id) : [...list, id];
  }

  async function createFlavorInline(selected, setSelected) {
    const name = sanitizeTextInput(flavorDraft, 60).trim();
    if (!name) {
      setFlavorError("Type a flavor name first.");
      return;
    }
    setFlavorError("");
    try {
      const { data } = await api.post("/flavors", { name });
      setFlavors((prev) => [...prev, data.flavor].sort((a, b) => a.name.localeCompare(b.name)));
      setSelected([...selected, data.flavor.id]);
      setFlavorDraft("");
      toast(`Flavor "${data.flavor.name}" created`, "success");
    } catch (err) {
      setFlavorError(getErrorMessage(err, "Could not create flavor."));
    }
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
    setIsAdding(true);
    try {
      await api.post("/products", {
        name: name.value,
        category: newProduct.category.trim() || "Fries",
        basePrice: price,
        flavorIds: newProduct.flavorIds,
      });
      toast(`Product "${name.value}" created`, "success");
      closeAddModal();
      setNewProduct({ name: "", category: "Fries", basePrice: "", flavorIds: [] });
      setFlavorDraft("");
      load();
    } catch (err) {
      setAddError(getErrorMessage(err, "Failed to create product."));
    } finally {
      setIsAdding(false);
    }
  }

  async function handleEditProduct(e) {
    e.preventDefault();
    setEditError("");
    const price = parseMoney(editing.basePrice);
    if (price === null || price <= 0) {
      setEditError("Enter a base price from P0.01 to P9,999,999.99.");
      return;
    }
    const origFlavors = [...(editing._flavorIds ?? [])].sort((a, b) => a - b);
    const nextFlavors = [...(editing.flavorIds ?? [])].sort((a, b) => a - b);
    const sameFlavors = origFlavors.length === nextFlavors.length &&
      origFlavors.every((id, i) => id === nextFlavors[i]);
    if (
      (editing.category || "Fries") === (editing._category || "Fries") &&
      price === Number(editing._basePrice) &&
      sameFlavors
    ) {
      toast("No changes — nothing to update on this product.", "info");
      closeEditModal();
      return;
    }
    setIsEditing(true);
    try {
      await api.patch(`/products/${editing.id}`, {
        category: editing.category.trim() || "Fries",
        basePrice: price,
        addFlavorIds: nextFlavors.filter((id) => !origFlavors.includes(id)),
        removeFlavorIds: origFlavors.filter((id) => !nextFlavors.includes(id)),
      });
      toast(`Product "${editing.name}" updated`, "success");
      closeEditModal();
      load();
    } catch (err) {
      setEditError(getErrorMessage(err, "Failed to update product."));
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
      setRenameError(getErrorMessage(err, "Rename failed."));
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
      toast(getErrorMessage(err, "Delete failed."), "error");
    } finally {
      setDeleting(null);
      setIsDeleting(false);
    }
  }

  function openEdit(p) {
    setEditing({
      ...p,
      category: p.category || "Fries",
      basePrice: String(p.basePrice ?? ""),
      flavorIds: (p.flavors ?? []).map((f) => f.id),
      _category: p.category || "Fries",
      _basePrice: p.basePrice,
      _flavorIds: (p.flavors ?? []).map((f) => f.id),
    });
    setEditError("");
    setFlavorDraft("");
    setFlavorError("");
  }

  function flavorCheckboxes(selected, setSelected) {
    return (
      <div className="flex flex-wrap gap-2">
        {flavors.map((f) => (
          <label
            key={f.id}
            style={{ display: "inline-flex", alignItems: "center", gap: "6px", cursor: "pointer" }}
          >
            <input
              type="checkbox"
              checked={selected.includes(f.id)}
              onChange={() => setSelected(toggleFlavor(selected, f.id))}
              style={{ width: "16px", height: "16px", cursor: "pointer" }}
            />
            {f.name}
          </label>
        ))}
        {flavors.length === 0 && <span className="muted small">No flavors yet — create one below.</span>}
      </div>
    );
  }

  function newFlavorRow(selected, setSelected) {
    return (
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
          onClick={() => createFlavorInline(selected, setSelected)}
        >
          Add
        </button>
      </div>
    );
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

        <section className="panel">
          {error ? (
            <div className="error-box">{error}</div>
          ) : (
            <DataTable
              loading={loading}
              fixedLayout={true}
              emptyMessage="No products yet"
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
                        <Badge key={f.id} variant="info">{f.name}</Badge>
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
                        title="Edit price, category, flavors"
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
          )}
        </section>

        {/* ADD PRODUCT MODAL */}
        {(addOpen || addClosing) && (
          <div className={`modal-backdrop ${addClosing ? "is-closing" : ""}`}>
            <div className={`modal ${addClosing ? "is-closing" : ""}`} onClick={(e) => e.stopPropagation()}>
              <h3><Plus size={22} className="muted"/> Add Product</h3>
              <p className="muted" style={{ marginBottom: "20px", lineHeight: "1.4" }}>
                New catalog item for the POS. Recipes can be added per flavor later.
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
                  <span>Flavors</span>
                  {flavorCheckboxes(newProduct.flavorIds, (ids) => setNewProduct({ ...newProduct, flavorIds: ids }))}
                </div>
                <div className="field">
                  <span>Create flavor</span>
                  {newFlavorRow(newProduct.flavorIds, (ids) => setNewProduct({ ...newProduct, flavorIds: ids }))}
                  {flavorError && <p className="error-box" role="alert" style={{ marginTop: "8px" }}>{flavorError}</p>}
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
            <div className={`modal ${editClosing ? "is-closing" : ""}`} onClick={(e) => e.stopPropagation()}>
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
                  <span>Flavors</span>
                  {editing && flavorCheckboxes(editing.flavorIds ?? [], (ids) => setEditing({ ...editing, flavorIds: ids }))}
                </div>
                <div className="field">
                  <span>Create flavor</span>
                  {editing && newFlavorRow(editing.flavorIds ?? [], (ids) => setEditing({ ...editing, flavorIds: ids }))}
                  {flavorError && <p className="error-box" role="alert" style={{ marginTop: "8px" }}>{flavorError}</p>}
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
