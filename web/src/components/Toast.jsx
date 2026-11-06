import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Check, Info, TriangleAlert, X } from "lucide-react";

const ToastContext = createContext(() => {});

// Maximum toasts on screen at once (oldest evicted first).
const MAX_VISIBLE_TOASTS = 4;
const MAX_VISIBLE_ERROR_TOASTS = 2;
const TOAST_EXIT_DURATION = 220;

// Module-level reference so non-React code (e.g. the axios interceptor in
// api.js) can emit a toast without calling a hook.
let toastPush = () => {};

/**
 * toast(message, type)           - plain toast, dismisses on its own timer
 * toast(message, type, {onClick, title}) - clickable toast: navigates via the
 *   callback, dismisses itself, and announces itself as a button.
 */
// eslint-disable-next-line react-refresh/only-export-components -- module bridge so non-React code (api.js) can push toasts
export function toast(message, type = "info", opts = {}) {
  toastPush(message, type, opts);
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);
  const exitTimersRef = useRef(new Map());
  const expiryTimersRef = useRef(new Map());

  const dismiss = useCallback((id) => {
    if (exitTimersRef.current.has(id)) return;
    clearTimeout(expiryTimersRef.current.get(id));
    expiryTimersRef.current.delete(id);
    setToasts((current) => {
      if (!current.some((toast) => toast.id === id && !toast.exiting)) return current;
      return current.map((toast) => toast.id === id ? { ...toast, exiting: true } : toast);
    });
    const timer = setTimeout(() => {
      exitTimersRef.current.delete(id);
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, TOAST_EXIT_DURATION);
    exitTimersRef.current.set(id, timer);
  }, []);

  // Cap simultaneous toasts so SSE bursts or bulk actions can't flood the
  // UI or stack dozens of live-region nodes for screen readers.
  const push = useCallback((message, type = "info", opts = {}) => {
    const id = ++idRef.current;
    setToasts((t) => {
      // Identical toast already visible: keep the original (and its timer)
      // instead of stacking a duplicate.
      if (t.some((x) => x.message === message && x.type === type)) return t;
      const next = [...t, { id, message, type, onClick: opts?.onClick, title: opts?.title, exiting: false }];
      const maxVisible = type === "error" ? MAX_VISIBLE_ERROR_TOASTS : MAX_VISIBLE_TOASTS;
      return next.slice(-maxVisible);
    });

    const timer = setTimeout(() => {
      expiryTimersRef.current.delete(id);
      dismiss(id);
    }, 5000);
    expiryTimersRef.current.set(id, timer);
  }, [dismiss]);

  useEffect(() => {
    toastPush = push;
    const exitTimers = exitTimersRef.current;
    const expiryTimers = expiryTimersRef.current;
    return () => {
      toastPush = () => {};
      exitTimers.forEach(clearTimeout);
      exitTimers.clear();
      expiryTimers.forEach(clearTimeout);
      expiryTimers.clear();
    };
  }, [push]);

  return (
    <ToastContext.Provider value={push}>
      {children}
      {/* NOTE: no aria-live here   each toast announces itself once via
          role=status/alert below. A live host + live items double-announces. */}
      <div className="toast-host">
        {toasts.map((t) => {
          const clickable = typeof t.onClick === "function";
          const kind = t.type === "warn" ? "warning" : t.type;
          const heading = {
            success: "Success",
            error: "Something went wrong",
            warning: "Heads up",
            info: "Update",
          }[kind] ?? "Notification";
          const activate = () => {
            dismiss(t.id);
            t.onClick?.();
          };
          return (
            <div
              key={t.id}
              className={`toast ${kind}${clickable ? " toast--clickable" : ""}${t.exiting ? " toast--exiting" : ""}`}
              role={t.type === "error" ? "alert" : clickable ? "button" : "status"}
              tabIndex={clickable ? 0 : undefined}
              aria-atomic="true"
              aria-label={clickable ? `${t.message}${t.title ? ` — ${t.title}` : ""}` : undefined}
              title={clickable ? t.title : undefined}
              onClick={clickable ? activate : undefined}
              onKeyDown={
                clickable
                  ? (event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        activate();
                      }
                    }
                  : undefined
              }
            >
              <span className="toast-icon" aria-hidden="true">
                {kind === "success" ? (
                  <Check size={20} strokeWidth={2.5} />
                ) : kind === "error" || kind === "warning" ? (
                  <TriangleAlert size={20} strokeWidth={2.5} />
                ) : (
                  <Info size={20} strokeWidth={2.5} />
                )}
              </span>

              <span className="toast-content">
                <span className="toast-heading">{heading}</span>
                <span className="toast-msg">{t.message}</span>
              </span>

              <button
                className="toast-close"
                type="button"
                aria-label="Dismiss notification"
                onClick={(e) => {
                  e.stopPropagation();
                  dismiss(t.id);
                }}
              >
                <X size={15} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- context hook colocated with its provider by React docs pattern
export function useToast() {
  return useContext(ToastContext);
}