import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { CheckCircle2, Info, XCircle } from "lucide-react";

const ToastContext = createContext(() => {});

// Module-level reference so non-React code (e.g. the axios interceptor in
// api.js) can emit a toast without calling a hook.
let toastPush = () => {};

export function toast(message, type = "info") {
  toastPush(message, type);
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);

  const push = useCallback((message, type = "info") => {
    const id = ++idRef.current;
    setToasts((t) => [...t, { id, message, type }]);
    setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
    }, 3800);
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
      <div className="toast-host">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.type}`}>
            {t.type === "success" ? (
              <CheckCircle2 size={17} />
            ) : t.type === "error" ? (
              <XCircle size={17} />
            ) : (
              <Info size={17} />
            )}
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
