import { useNavigate } from "react-router-dom";
import { ShieldCheck } from "lucide-react";
import RecoveryFlow from "./RecoveryFlow.jsx";

const APP_VERSION = import.meta.env.VITE_APP_VERSION || "0.1.0";

/**
 * Standalone `/forgot-password` route: the same RecoveryFlow used inline on
 * the login page, framed for direct visits (logo + footer). Exiting returns
 * to `/login`; the inline frame instead swaps back to the login form.
 */
export default function ForgotPassword() {
  const navigate = useNavigate();

  return (
    <div className="login-split">
      <div className="login-form-side" style={{ width: "100%" }}>
        <div className="login-form-container" style={{ maxWidth: 460 }}>
          <div className="login-logo-desktop">
            <img src="/logo.png" alt="CartIQ Logo" className="logo-icon-medium" />
            <strong style={{ fontSize: "20px", color: "var(--text)" }}>CartIQ</strong>
          </div>

          <RecoveryFlow onExitToLogin={() => navigate("/login")} />

          <div className="recovery-footer">
            <span>© 2026 CartIQ · v{APP_VERSION}</span>
            <span className="recovery-secure">
              <ShieldCheck size={14} /> Secure Session
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
