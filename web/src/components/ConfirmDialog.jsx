import { useEffect, useState } from "react";

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  danger = false,
  onConfirm,
  onCancel,
}) {
  // renderOpen controls whether the component is actually in the DOM
  const [renderOpen, setRenderOpen] = useState(open);
  // isClosing controls the CSS animation classes
  const [isClosing, setIsClosing] = useState(false);

  useEffect(() => {
    if (open) {
      // Kapag binuksan, i-render agad at tanggalin ang isClosing state
      setRenderOpen(true);
      setIsClosing(false);
      // Background Scroll Lock
      document.body.style.overflow = "hidden";
    } else if (renderOpen) {
      // Kapag sinara mula sa parent, i-trigger ang closing animation
      setIsClosing(true);
      document.body.style.overflow = "";
      
      // Maghintay ng 150ms bago tuluyang i-unmount para makapag-play ang fade-out
      const timer = setTimeout(() => {
        setRenderOpen(false);
        setIsClosing(false);
      }, 150);
      
      return () => clearTimeout(timer);
    } else {
      // Cleanup fallback
      document.body.style.overflow = "";
    }
  }, [open, renderOpen]);

  // Kung hindi open at tapos na ang animation, huwag i-render
  if (!renderOpen) return null;

  return (
    // STRICT CLICK-TO-CLOSE: Walang onClick={onCancel} sa backdrop
    <div className={`modal-backdrop ${isClosing ? "is-closing" : ""}`}>
      <div 
        className={`modal ${isClosing ? "is-closing" : ""}`} 
        onClick={(e) => e.stopPropagation()} // Pigilan ang propagation kung sakali
      >
        <h3>{title}</h3>
        
        {message && (
          <p className="muted" style={{ marginBottom: "20px", lineHeight: "1.4" }}>
            {message}
          </p>
        )}
        
        <div className="modal-actions">
          <button 
            type="button" 
            className="ghost" 
            onClick={onCancel}
            disabled={isClosing} // Para hindi ma-spam ang click habang nagco-close
          >
            Cancel
          </button>
          
          <button 
            type="button" 
            className={danger ? "danger" : ""} 
            onClick={onConfirm}
            disabled={isClosing}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}