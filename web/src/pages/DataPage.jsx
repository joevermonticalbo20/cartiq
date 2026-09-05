import { useRef, useState } from "react";
import { Download, FileUp, FileDown } from "lucide-react";
import api from "../api.js";
import Badge from "../components/Badge.jsx";
import ConfirmDialog from "../components/ConfirmDialog.jsx";
import PageErrorBoundary from "../components/PageErrorBoundary.jsx";
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
      toast(err.response?.data?.error || "Export failed", "error");
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
      setPreview(res.data);
      if (res.data.errors.length > 0) {
        toast(`${res.data.errors.length} row(s) need fixing before commit`, "info");
      } else {
        toast(`${res.data.valid_count} valid row(s) - ready to commit`, "success");
      }
    } catch (err) {
      toast(err.response?.data?.error || "Import preview failed", "error");
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
      toast(`Committed ${preview.valid_count} product(s) to the catalog`, "success");
      setPreview(null);
      pendingFile.current = null;
    } catch (err) {
      toast(err.response?.data?.error || "Commit failed", "error");
    } finally {
      setBusyImport(false);
      setConfirmOpen(false);
    }
  }

  return (
    <PageErrorBoundary>
    <div className="page-container">
    <div className="settings-grid">
      <section className="panel">
        <h3 className="section-title">Export workbooks</h3>
        <p className="muted small">
          Download real Excel files for the selected period. Sales include a
          line-item sheet plus per-cart summary.
        </p>
        <label className="field" style={{ marginBottom: "var(--space-2)" }}>
          Period
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </label>
        <div className="seg">
          {["sales", "inventory", "expenses", "shifts"].map((ds) => (
            <button
              key={ds}
              className="ghost small-btn"
              disabled={busyExport !== null}
              aria-busy={busyExport === ds}
              onClick={() => doExport(ds)}
            >
              <Download size={14} /> {busyExport === ds ? `${ds}…` : ds}
            </button>
          ))}
        </div>
      </section>

      <section className="panel">
        <h3 className="section-title">Bulk import products</h3>
        <p className="muted small">
          Columns: name* | category | basePrice* | flavors (&quot;Cheese;BBQ&quot;).
          Preview validates every row first; commit stays blocked until the file
          is error-free.
        </p>
        <div className="flex gap-2" style={{ flexWrap: "wrap" }}>
          <button
            className="ghost"
            disabled={busyImport}
            onClick={() => fileRef.current?.click()}
          >
            <FileUp size={16} /> {busyImport ? "Reading file…" : "Choose .xlsx file"}
          </button>
          <a
            className="ghost"
            href="/templates/products-template.xlsx"
            download
            style={{ textDecoration: "none" }}
          >
            <FileDown size={16} /> Download sample template
          </a>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx"
          onChange={handleFile}
          className="hidden"
        />

        {preview && (
          <div style={{ marginTop: "var(--space-3)" }}>
            <table className="data">
              <tbody>
                {preview.errors.map((e, i) => (
                  <tr key={`e${i}`}>
                    <td><Badge variant="danger">ROW {e.row}</Badge></td>
                    <td>{e.reason}</td>
                  </tr>
                ))}
                {preview.errors.length === 0 && (
                  <tr>
                    <td><Badge variant="ok">READY</Badge></td>
                    <td>{preview.valid_count} valid row(s), no conflicts.</td>
                  </tr>
                )}
              </tbody>
            </table>
            <button
              style={{ marginTop: "var(--space-2)" }}
              onClick={() => setConfirmOpen(true)}
              disabled={busyImport || preview.errors.length > 0 || preview.valid_count === 0}
            >
              Commit {preview.valid_count} product(s)
            </button>
          </div>
        )}
      </section>

      <ConfirmDialog
        open={confirmOpen}
        title="Commit products?"
        message={`${preview?.valid_count ?? 0} new product(s) will be added to the catalog. This cannot be undone via this screen.`}
        confirmLabel="Commit"
        onConfirm={commit}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
    </div>
    </PageErrorBoundary>
  );
}
