import { useRef, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { Download, FileUp, FileDown, CheckCircle2, AlertTriangle } from "lucide-react";

import api, { getErrorMessage } from "../api.js";
import Badge from "../components/Badge.jsx";
import ConfirmDialog from "../components/ConfirmDialog.jsx";
import PageErrorBoundary from "../components/PageErrorBoundary.jsx";
import PageHeader from "../components/PageHeader.jsx";
import { useToast } from "../components/Toast.jsx";
import Select from "../components/Select.jsx";

async function downloadExport(dataset, params = {}) {
  const res = await api.get(`/export/${dataset}`, {
    params,
    responseType: "blob",
  });
  const url = URL.createObjectURL(res.data);
  const a = document.createElement("a");
  a.href = url;

  let filename = `cartiq-${dataset}`;
  if (params.month) filename += `-${params.month}`;
  else if (params.startDate && params.endDate) filename += `-${params.startDate}-to-${params.endDate}`;
  else filename += `-all`;

  a.download = `${filename}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Failures arrive as a Blob (responseType) hiding the server's JSON
// {error}   parse it back out so users see the real reason.
async function blobErrorMessage(err, fallback) {
  try {
    const blob = err?.response?.data;
    if (blob instanceof Blob) {
      const parsed = JSON.parse(await blob.text());
      if (parsed?.error) return parsed.error;
    }
  } catch {
    /* fall through to generic message */
  }
  return getErrorMessage(err, fallback);
}

export default function DataPage() {
  const toast = useToast();
  const { user } = useOutletContext();
  const isOwner = user?.role === "OWNER";

  const nowMonth = new Date().toISOString().slice(0, 7);

  // --- NEW STATES FOR UPGRADED EXPORT FILTERS ---
  const [exportType, setExportType] = useState("month"); // "month", "custom", "all"
  const [month, setMonth] = useState(nowMonth);
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");

  const [busyExport, setBusyExport] = useState(null);
  const [busyImport, setBusyImport] = useState(false);
  const [preview, setPreview] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Custom-range guard: the backend 400s incomplete/inverted ranges, so
  // block the export buttons upfront with an inline explanation instead.
  const rangeError =
    exportType === "custom"
      ? !customStart || !customEnd
        ? "Pick both start and end dates for a custom export."
        : customStart > customEnd
          ? "Start date must not be after end date."
          : ""
      : "";

  const fileRef = useRef(null);
  const pendingFile = useRef(null);

  // --- UPDATED EXPORT HANDLER ---
  async function doExport(dataset) {
    setBusyExport(dataset);
    try {
      const params = {};
      if (exportType === "month" && month) {
        params.month = month;
      } else if (exportType === "custom" && customStart && customEnd) {
        if (rangeError) {
          toast(rangeError, "error");
          return;
        }
        params.startDate = customStart;
        params.endDate = customEnd;
      }
      
      await downloadExport(dataset, params);
      toast(`Exported ${dataset} successfully`, "success");
    } catch (err) {
      toast(await blobErrorMessage(err, "Export failed"), "error");
    } finally {
      setBusyExport(null);
    }
  }

  // --- CATALOG EXPORT HANDLER (For 'Current' Button) ---
  async function doExportCatalog() {
    setBusyExport('products');
    try {
      await downloadExport('products', {}); // No date filter needed for catalog
      toast(`Exported current catalog successfully`, "success");
    } catch (err) {
      toast(await blobErrorMessage(err, "Export failed"), "error");
    } finally {
      setBusyExport(null);
    }
  }

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    setBusyImport(true);
    try {
      pendingFile.current = file;
      const form = new FormData();
      form.append("file", file);

      const res = await api.post("/import/products?dry_run=true", form);
      const errors = res.data?.errors ?? [];
      const validCount = res.data?.valid_count ?? 0;

      setPreview({ errors, valid_count: validCount, ...(res.data ?? {}) });

      if (errors.length > 0) {
        toast(`${errors.length} row(s) need fixing before commit`, "warn");
      } else {
        toast(`${validCount} valid row(s) - ready to commit`, "success");
      }
    } catch (err) {
      toast(getErrorMessage(err, "Import preview failed"), "error");
      setPreview(null);
    } finally {
      setBusyImport(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function commit() {
    if (!pendingFile.current || busyImport) return;
    setBusyImport(true);
    try {
      const form = new FormData();
      form.append("file", pendingFile.current);
      await api.post("/import/products?dry_run=false", form);
      toast(`Committed ${preview?.valid_count ?? 0} product(s) to the catalog`, "success");
      setPreview(null);
      pendingFile.current = null;
    } catch (err) {
      toast(getErrorMessage(err, "Commit failed"), "error");
    } finally {
      setBusyImport(false);
      setConfirmOpen(false);
    }
  }

  function downloadTemplate() {
    const link = document.createElement("a");
    link.href = "/templates/products-template.xlsx";
    link.download = "products-template.xlsx";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  return (
    <PageErrorBoundary>
      <div className="page-container wide">
        <PageHeader
          eyebrow="Operations"
          title="Data Hub"
          sub="Excel out, product workbooks in - previewed before anything commits."
        />

        <div 
          className="settings-grid" 
          style={{ 
            gap: "var(--space-4)", 
            gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", 
            alignItems: "stretch" /* FIX: Pinalitan ang 'start' para maging pantay ang height ng panels */
          }}
        >
          
          {/* EXPORT PANEL (owner-only: financial datasets) */}
          {isOwner && (
          <section className="panel" style={{ display: "flex", flexDirection: "column", padding: "var(--space-5)" }}>
            <div style={{ marginBottom: "var(--space-4)" }}>
              <h3 className="section-title" style={{ borderBottom: "none", padding: 0, margin: "0 0 var(--space-2) 0" }}>
                Export workbooks
              </h3>
              <p className="muted small" style={{ margin: 0, lineHeight: 1.5 }}>
                Download real Excel files for the selected period. Sales include a
                line-item sheet plus per-cart summary.
              </p>
            </div>
            
            <label className="field" style={{ marginBottom: "var(--space-2)" }}>
              Export Period
              <Select
                value={exportType}
                onChange={setExportType}
                options={[
                  { value: "month", label: "Specific Month" },
                  { value: "custom", label: "Custom Date Range" },
                  { value: "all", label: "All Time" }
                ]}
              />
            </label>

            <div style={{ marginBottom: "var(--space-4)", minHeight: "36px" }}>
              {exportType === "month" && (
                <input 
                  type="month" 
                  value={month} 
                  onChange={(e) => setMonth(e.target.value)} 
                  style={{ height: "36px", width: "100%" }}
                />
              )}
              {exportType === "custom" && (
                <div className="flex gap-2" style={{ animation: "rise-in 0.2s ease" }}>
                  <input 
                    type="date" 
                    value={customStart} 
                    onChange={(e) => setCustomStart(e.target.value)} 
                    style={{ height: "36px", width: "100%" }}
                  />
                  <input 
                    type="date" 
                    value={customEnd} 
                    onChange={(e) => setCustomEnd(e.target.value)} 
                    style={{ height: "36px", width: "100%" }}
                  />
                </div>
              )}
              {rangeError && (
                <p className="error-box" role="alert" style={{ marginTop: "var(--space-2)" }}>{rangeError}</p>
              )}
            </div>
            
            {/* FIX: marginTop: "auto" keeps the buttons pinned at the absolute bottom */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginTop: "auto" }}>
              {["sales", "inventory", "expenses", "shifts"].map((ds) => (
                <button
                  key={ds}
                  className="ghost small-btn"
                  disabled={busyExport !== null || Boolean(rangeError)}
                  aria-busy={busyExport === ds}
                  onClick={() => doExport(ds)}
                  style={{ textTransform: "capitalize", justifyContent: "center" }}
                >
                  <Download size={14} /> {busyExport === ds ? `Exporting...` : ds}
                </button>
              ))}
            </div>
          </section>
          )}

          {/* IMPORT PANEL */}
          <section className="panel" style={{ display: "flex", flexDirection: "column", padding: "var(--space-5)" }}>
            <div style={{ marginBottom: "var(--space-4)" }}>
              <h3 className="section-title" style={{ borderBottom: "none", padding: 0, margin: "0 0 var(--space-2) 0" }}>
                Bulk import products
              </h3>
              <p className="muted small" style={{ margin: 0, lineHeight: 1.5 }}>
                Columns required: <strong style={{ color: "var(--text)" }}>name, category, basePrice, flavors</strong>.
                Preview validates every row first; commit stays blocked until the file is error-free.
              </p>
            </div>
            
            {/* FIX: Binalot sa isang flex column wrapper na may marginTop: 'auto' para bumaba ang mga ito */}
            <div style={{ marginTop: "auto", display: "flex", flexDirection: "column" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "8px" }}>
                <button
                  className="ghost small-btn"
                  onClick={downloadTemplate}
                  style={{ height: "36px", justifyContent: "center", padding: "0 4px" }}
                  title="Download Blank Template"
                >
                  <FileDown size={14} /> Template
                </button>
                <button
                  className="ghost small-btn"
                  onClick={doExportCatalog}
                  disabled={busyExport !== null}
                  style={{ height: "36px", justifyContent: "center", padding: "0 4px" }}
                  title="Export Current Product Database"
                >
                  <Download size={14} /> {busyExport === 'products' ? "..." : "Current"}
                </button>
                <button
                  className="small-btn"
                  disabled={busyImport}
                  onClick={() => fileRef.current?.click()}
                  style={{ height: "36px", justifyContent: "center", padding: "0 4px" }}
                  title="Upload Excel File"
                >
                  <FileUp size={14} /> {busyImport ? "..." : "Upload"}
                </button>
              </div>
              
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx"
                onChange={handleFile}
                className="hidden"
              />
              
              {/* PREVIEW TABLE */}
              {preview && (
                <div style={{ marginTop: "var(--space-4)", paddingTop: "var(--space-4)", borderTop: "1px solid var(--border)" }}>
                  <div className="flex items-center justify-between" style={{ marginBottom: "var(--space-3)" }}>
                    <h4 style={{ fontSize: "var(--fs-sm)", margin: 0, color: "var(--accent)", fontWeight: "var(--fw-bold)" }}>
                      Validation Preview
                    </h4>
                    <Badge variant={(preview.errors ?? []).length > 0 ? "danger" : "ok"}>
                      {(preview.errors ?? []).length > 0 ? `${(preview.errors ?? []).length} Errors` : "Valid"}
                    </Badge>
                  </div>

                  <div className="table-wrap" tabIndex={0} role="region" aria-label="Import preview" style={{ maxHeight: "250px", overflowY: "auto" }}>
                    <table className="data table-fixed">
                      <thead>
                        <tr>
                          <th style={{ width: 90, padding: "6px 12px" }}>Row</th>
                          <th style={{ padding: "6px 12px" }}>Details</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(preview.errors ?? []).map((e, i) => (
                          <tr key={`e${i}`}>
                            <td style={{ padding: "8px 12px" }}>
                              <Badge variant="danger">#{e.row}</Badge>
                            </td>
                            <td style={{ color: "var(--danger)", padding: "8px 12px" }}>
                              <div className="flex items-center gap-2">
                                <AlertTriangle size={13} style={{ flexShrink: 0 }} />
                                <span style={{ fontSize: "var(--fs-xs)" }}>{e.reason}</span>
                              </div>
                            </td>
                          </tr>
                        ))}
                        {(preview.errors ?? []).length === 0 && (
                          <tr>
                            <td style={{ padding: "8px 12px" }}>
                              <Badge variant="ok">READY</Badge>
                            </td>
                            <td style={{ color: "var(--success)", padding: "8px 12px" }}>
                              <div className="flex items-center gap-2">
                                <CheckCircle2 size={13} style={{ flexShrink: 0 }} />
                                <span style={{ fontSize: "var(--fs-xs)" }}>{preview.valid_count ?? 0} valid row(s), no conflicts found.</span>
                              </div>
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  
                  <button
                    style={{ marginTop: "var(--space-3)", width: "100%" }}
                    onClick={() => setConfirmOpen(true)}
                    disabled={busyImport || (preview.errors ?? []).length > 0 || (preview.valid_count ?? 0) === 0}
                  >
                    Commit {preview.valid_count ?? 0} product(s)
                  </button>
                </div>
              )}
            </div>

          </section>

          <ConfirmDialog
            open={confirmOpen}
            title="Commit products?"
            message={`${preview?.valid_count ?? 0} new product(s) will be added to the catalog. This action cannot be undone here.`}
            confirmLabel="Commit Data"
            pending={busyImport}
            pendingLabel="Committing..."
            onConfirm={commit}
            onCancel={() => setConfirmOpen(false)}
          />
        </div>
      </div>
    </PageErrorBoundary>
  );
}