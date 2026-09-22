import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { CheckCircle2, Info, XCircle, X } from "lucide-react";

const ToastContext = createContext(() => {});

// Maximum toasts on screen at once (oldest evicted first).
const MAX_VISIBLE_TOASTS = 4;
const MAX_VISIBLE_ERROR_TOASTS = 2;

// Module-level reference so non-React code (e.g. the axios interceptor in
// api.js) can emit a toast without calling a hook.
let toastPush = () => {};

// eslint-disable-next-line react-refresh/only-export-components -- module bridge so non-React code (api.js) can push toasts
export function toast(message, type = "info") {
  toastPush(message, type);
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  // Cap simultaneous toasts so SSE bursts or bulk actions can't flood the
  // UI or stack dozens of live-region nodes for screen readers.
  const push = useCallback((message, type = "info") => {
    const id = ++idRef.current;
    setToasts((t) => {
      // Identical toast already visible: keep the original (and its timer)
      // instead of stacking a duplicate.
      if (t.some((x) => x.message === message && x.type === type)) return t;
      const next = [...t, { id, message, type }];
      const maxVisible = type === "error" ? MAX_VISIBLE_ERROR_TOASTS : MAX_VISIBLE_TOASTS;
      return next.slice(-maxVisible);
    });

    setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
    }, 5000);
  }, []);

  useEffect(() => {
    toastPush = push;
    return () => {
      toastPush = () => {};
    };
  }, [push]);

  return (
    <ToastContext.Provider value={push}>
      {children}
      {/* NOTE: no aria-live here   each toast announces itself once via
          role=status/alert below. A live host + live items double-announces. */}
      <div className="toast-host">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast ${t.type}`}
            role={t.type === "error" ? "alert" : "status"}
            aria-atomic="true"
          >
            {t.type === "success" ? (
              <CheckCircle2 size={18} />
            ) : t.type === "error" ? (
              <XCircle size={18} />
            ) : (
              <Info size={18} />
            )}
            
            <span className="toast-msg">{t.message}</span>
            
            <button
              className="toast-close"
              aria-label="Dismiss notification"
              onClick={() => dismiss(t.id)}
            >
              <X size={15} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- context hook colocated with its provider by React docs pattern
export function useToast() {
  return useContext(ToastContext);
}