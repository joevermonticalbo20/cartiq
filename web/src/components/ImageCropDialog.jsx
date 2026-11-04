import { useEffect, useRef, useState } from "react";
import Cropper from "cropperjs";
import "cropperjs/dist/cropper.css";
import { Crop, ImagePlus } from "lucide-react";

export const VIEW = 300; // crop stage square in the modal, px
export const OUT = 512; // saved photo, px

/**
 * Insert / crop a product photo. `seed` is the product's current image (any
 * `<img>`-loadable URL); it can be re-cropped directly. The operator drags
 * and resizes the square on the photo itself — the POS card shows exactly
 * that square. Saving returns a JPEG data URL — the caller uploads it; this
 * dialog never talks to the API.
 */
export default function ImageCropDialog({ seed, onCancel, onSave }) {
  const [src, setSrc] = useState(seed || null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const imgRef = useRef(null);
  const cropperRef = useRef(null);
  const fileRef = useRef(null);

  // The cropper binds to the <img> once the source changes; a fresh mount
  // per source keeps zoom/position state honest.
  useEffect(() => {
    if (!src || !imgRef.current) return undefined;
    const cropper = new Cropper(imgRef.current, {
      aspectRatio: 1, // POS card shows a square
      viewMode: 1, // the crop box can never leave the photo
      dragMode: "move", // drag the photo under the square, or the square itself
      autoCropArea: 0.9,
      background: false,
      center: true,
      highlight: false,
      guides: true,
      cropBoxMovable: true,
      cropBoxResizable: true,
      toggleDragModeOnDblclick: false,
    });
    cropperRef.current = cropper;
    return () => {
      cropper.destroy();
      cropperRef.current = null;
    };
  }, [src]);

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
      setError("");
    };
    reader.onerror = () => setError("Could not read that file.");
    reader.readAsDataURL(file);
  }

  function save() {
    const cropper = cropperRef.current;
    if (!cropper) {
      return;
    }
    setSaving(true);
    try {
      const canvas = cropper.getCroppedCanvas({
        width: OUT,
        height: OUT,
        imageSmoothingQuality: "high",
      });
      if (!canvas) {
        setSaving(false);
        setError("Could not process that image here — try a JPEG or PNG.");
        return;
      }
      const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
      if (dataUrl.length > 700000) {
        setSaving(false);
        setError("That crop is too large — tighten the square or pick a smaller photo.");
        return;
      }
      onSave({ dataUrl, mime: "image/jpeg" });
    } catch {
      setSaving(false);
      setError("Could not process that image here — try a JPEG or PNG.");
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
          Drag and resize the square on the photo itself. The square is exactly what the POS card shows.
        </p>

        {src ? (
          <div
            style={{
              width: "100%",
              maxWidth: VIEW,
              height: VIEW,
              margin: "0 auto",
              overflow: "hidden",
              borderRadius: 16,
              background: "var(--surface-alt)",
              border: "1px solid var(--border)",
            }}
          >
            {/* cropper.js takes this image over and renders the stage itself */}
            <img ref={imgRef} src={src} alt="" style={{ display: "block", maxWidth: "100%" }} />
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
          <button type="button" onClick={save} disabled={!src || saving}>
            {saving ? "Saving..." : "Use this photo"}
          </button>
        </div>
      </div>
    </div>
  );
}
