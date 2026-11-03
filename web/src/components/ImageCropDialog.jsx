import { useRef, useState } from "react";
import { Crop, ImagePlus } from "lucide-react";

export const VIEW = 300; // crop viewport, px (square — what a POS card shows)
export const OUT = 512; // saved photo, px

/**
 * Square-crop geometry for a photo in a `view × view` frame.
 * The image always COVERS the frame (no letterboxing): the base scale is
 * max(view/w, view/h), zoom multiplies it, and panning is clamped so the
 * frame can never show past the photo's edge. Pure so the math is testable
 * without a DOM.
 *
 * Returns the transform for display (scale, dw, dh, ox, oy) plus the source
 * rectangle (sx, sy, sw, sh) to draw into a view-sized canvas.
 */
// eslint-disable-next-line react-refresh/only-export-components -- pure helper colocated with its only consumer, unit-tested in place
export function cropGeometry(imgW, imgH, view = VIEW, zoom = 1, offset = { x: 0, y: 0 }) {
  const w = Math.max(1, Number(imgW) || 1);
  const h = Math.max(1, Number(imgH) || 1);
  const z = Math.max(1, Number(zoom) || 1);
  // Math.max can hand back -0 (e.g. Math.max(-0, -9999)); normalize so
  // Object.is comparisons and serialized values stay clean.
  const nz = (v) => (v === 0 ? 0 : v);
  const scale = Math.max(view / w, view / h) * z;
  const dw = w * scale;
  const dh = h * scale;
  const maxX = Math.max(0, (dw - view) / 2);
  const maxY = Math.max(0, (dh - view) / 2);
  const ox = nz(Math.max(-maxX, Math.min(maxX, Number(offset?.x) || 0)));
  const oy = nz(Math.max(-maxY, Math.min(maxY, Number(offset?.y) || 0)));
  const left = (view - dw) / 2 + ox;
  const top = (view - dh) / 2 + oy;
  const sx = Math.max(0, -left / scale);
  const sy = Math.max(0, -top / scale);
  const sw = Math.min(w - sx, view / scale);
  const sh = Math.min(h - sy, view / scale);
  return { scale, dw, dh, ox, oy, sx, sy, sw, sh };
}

/**
 * Insert / crop a product photo. `seed` is the product's current image (any
 * <img>-loadable URL); it can be re-cropped directly. Saving returns a JPEG
 * data URL — the caller uploads it; this dialog never talks to the API.
 *
 * The parent mounts this only while open, so every open starts from `seed`
 * with fresh zoom/pan state (no syncing effect needed).
 */
export default function ImageCropDialog({ seed, onCancel, onSave }) {
  const [src, setSrc] = useState(seed || null);
  const [info, setInfo] = useState(null); // { w, h } once loaded
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const imgRef = useRef(null);
  const fileRef = useRef(null);
  const dragRef = useRef(null);

  const geo = info ? cropGeometry(info.w, info.h, VIEW, zoom, offset) : null;

  function pickFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      setError("Choose an image file (JPEG, PNG, or WebP).");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setSrc(String(reader.result));
      setInfo(null);
      setZoom(1);
      setOffset({ x: 0, y: 0 });
      setError("");
    };
    reader.onerror = () => setError("Could not read that file.");
    reader.readAsDataURL(file);
  }

  function onPointerDown(e) {
    if (!info) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
  }

  function onPointerMove(e) {
    const d = dragRef.current;
    if (!d) return;
    setOffset({ x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) });
  }

  function endDrag() {
    dragRef.current = null;
  }

  function save() {
    const el = imgRef.current;
    if (!el || !info) return;
    setSaving(true);
    try {
      const g = cropGeometry(info.w, info.h, VIEW, zoom, offset);
      const canvas = document.createElement("canvas");
      canvas.width = OUT;
      canvas.height = OUT;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(el, g.sx, g.sy, g.sw, g.sh, 0, 0, OUT, OUT);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
      if (dataUrl.length > 700000) {
        setError("That crop is too large — try a smaller photo.");
        setSaving(false);
        return;
      }
      onSave({ dataUrl, mime: "image/jpeg" });
    } catch {
      setError("Could not process that image here — try a JPEG or PNG.");
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="crop-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="crop-title">
          <Crop size={22} className="muted" /> Insert photo
        </h3>
        <p className="muted" style={{ marginBottom: "16px", lineHeight: 1.4 }}>
          Drag to move, slide to zoom. The square is exactly what the POS card shows.
        </p>

        {src ? (
          <div
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            style={{
              position: "relative",
              width: VIEW,
              height: VIEW,
              maxWidth: "100%",
              margin: "0 auto",
              overflow: "hidden",
              borderRadius: 16,
              background: "var(--surface-alt)",
              border: "1px solid var(--border)",
              touchAction: "none",
              cursor: info ? "grab" : "default",
            }}
          >
            <img
              ref={imgRef}
              src={src}
              alt=""
              crossOrigin="anonymous"
              draggable={false}
              onLoad={(e) =>
                setInfo({
                  w: e.currentTarget.naturalWidth || 1,
                  h: e.currentTarget.naturalHeight || 1,
                })
              }
              style={{
                position: "absolute",
                left: "50%",
                top: "50%",
                width: geo ? geo.dw : "100%",
                height: geo ? geo.dh : "auto",
                transform: `translate(-50%, -50%) translate(${geo ? geo.ox : 0}px, ${geo ? geo.oy : 0}px)`,
                userSelect: "none",
                pointerEvents: "none",
              }}
            />
          </div>
        ) : (
          <div
            style={{
              width: VIEW,
              height: VIEW,
              maxWidth: "100%",
              margin: "0 auto",
              borderRadius: 16,
              background: "var(--surface-alt)",
              border: "1px dashed var(--border-strong)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              color: "var(--text-muted)",
            }}
          >
            <ImagePlus size={28} aria-hidden="true" />
            <span className="small">Pick a photo to crop</span>
          </div>
        )}

        <div style={{ display: "flex", gap: "12px", alignItems: "center", marginTop: "16px", flexWrap: "wrap" }}>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={pickFile} />
          <button type="button" className="ghost small-btn" onClick={() => fileRef.current?.click()}>
            <ImagePlus size={14} /> {src ? "Choose another" : "Choose photo"}
          </button>
          <label style={{ display: "flex", alignItems: "center", gap: "8px", flex: 1, minWidth: "180px" }}>
            <span className="muted small">Zoom</span>
            <input
              type="range"
              min="1"
              max="3"
              step="0.01"
              value={zoom}
              disabled={!info}
              onChange={(e) => setZoom(Number(e.target.value))}
              style={{ flex: 1 }}
            />
          </label>
        </div>

        {error && (
          <p className="error-box" role="alert" style={{ marginTop: "12px" }}>
            {error}
          </p>
        )}

        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
          <button type="button" onClick={save} disabled={!info || saving}>
            {saving ? "Saving..." : "Use this photo"}
          </button>
        </div>
      </div>
    </div>
  );
}
