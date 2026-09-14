import { useRef, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { Download, FileUp, FileDown, CheckCircle2, AlertTriangle } from "lucide-react";
import api, { getErrorMessage } from "../api.js";
import Badge from "../components/Badge.jsx";
import ConfirmDialog from "../components/ConfirmDialog.jsx";
import PageErrorBoundary from "../components/PageErrorBoundary.jsx";
import PageHeader from "../components/PageHeader.jsx";
import { useToast } from "../components/Toast.jsx";

async function downloadExport(dataset, month) {
  const res = await api.get(`/export/${dataset}`, {
    params: month ? { month } : {},
    responseType: "blob",
  });
  const url = URL.createObjectURL(res.data);
  const a = document.createElement("a");
  a.href = url;
  a.download = `cartiq-${dataset}${month ? `-${month}` : ""}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function DataPage() {
  const toast = useToast();
  const { user } = useOutletContext();
  const isOwner = user?.role === "OWNER";
  const nowMonth = new Date().toISOString().slice(0, 7);
  const [month, setMonth] = useState(nowMonth);
  const [busyExport, setBusyExport] = useState(null);
  const [busyImport, setBusyImport] = useState(false);
  const [preview, setPreview] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const fileRef = useRef(null);
  const pendingFile = useRef(null);

  async function doExport(dataset) {
    setBusyExport(dataset);
    try {
      await downloadExport(dataset, month);
      toast(`Downloaded cartiq-${dataset}-${month || "all"}.xlsx`, "success");
    } catch (err) {
      toast(getErrorMessage(err, "Export failed"), "error");
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
    if (!pendingFile.current) return;
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

  // Function para i-trigger ang download gamit ang totoong button
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
            alignItems: "start" 
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
            
            <label className="field" style={{ marginBottom: "var(--space-4)" }}>
              Select Period
              <input 
                type="month" 
                value={month} 
                onChange={(e) => setMonth(e.target.value)} 
                style={{ height: "36px" }}
              />
            </label>
            
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginTop: "auto" }}>
              {["sales", "inventory", "expenses", "shifts"].map((ds) => (
                <button
                  key={ds}
                  className="ghost small-btn"
                  disabled={busyExport !== null}
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
            
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
              {/* Ginawa na nating totoong <button> ito para makuha niya ang base CSS styles */}
              <button
                className="ghost small-btn"
                onClick={downloadTemplate}
                style={{ height: "36px", justifyContent: "center" }}
              >
                <FileDown size={14} /> Template
              </button>
              <button
                className="small-btn"
                disabled={busyImport}
                onClick={() => fileRef.current?.click()}
                style={{ height: "36px", justifyContent: "center" }}
              >
                <FileUp size={14} /> {busyImport ? "Reading..." : "Upload .xlsx"}
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
          </section>

          <ConfirmDialog
            open={confirmOpen}
            title="Commit products?"
            message={`${preview?.valid_count ?? 0} new product(s) will be added to the catalog. This action cannot be undone here.`}
            confirmLabel="Commit Data"
            onConfirm={commit}
            onCancel={() => setConfirmOpen(false)}
          />
        </div>
      </div>
    </PageErrorBoundary>
  );
}