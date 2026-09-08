import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Eye, EyeOff, XCircle, User, Lock, ArrowRight, Shield, Zap } from "lucide-react";
import api from "../api.js";
import Badge from "../components/Badge.jsx";

const APP_VERSION = import.meta.env.VITE_APP_VERSION || "0.1.0";

export default function Login() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [capsOn, setCapsOn] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  
  const [userFocused, setUserFocused] = useState(false);
  const [passwordFocused, setPasswordFocused] = useState(false);

  const passwordRef = useRef(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const { data } = await api.post("/auth/login", { username, password });
      localStorage.setItem("cartiq_token", data.token);
      navigate("/dashboard");
    } catch (err) {
      setError(err.response?.data?.error || "Login failed. Is the API running?");
      passwordRef.current?.focus();
    } finally {
      setLoading(false);
    }
  }

  const TiltedPreviewCard = ({ className = "" }) => (
    <div className={`login-preview ${className}`} aria-hidden="true">
      <div className="login-preview-header">
        <span className="login-preview-label">SALES TODAY</span>
        <div className="login-preview-row">
          <strong className="login-preview-value">₱12,450</strong>
          <span className="login-preview-trend">↑ +8.2%</span>
        </div>
      </div>
      
      {/* Improved Graph Area */}
      <div className="login-preview-chart-area">
        <div className="login-preview-bars">
          {[38, 62, 48, 78, 58, 92, 70].map((h, i) => {
            const days = ["M", "T", "W", "T", "F", "S", "S"];
            const isPeak = i === 5;
            return (
              <div
                key={i}
                className="login-preview-barcol"
                style={{ "--h": `${h}%` }}
              >
                {isPeak && <span className="login-preview-peak">PEAK</span>}
                <div className={`bar-wrapper${isPeak ? " peak" : ""}`}>
                  <span className="bar" />
                </div>
                <span className="bar-label">{days[i]}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="login-preview-carts">
        <span><i className="dot ok" /> CART-01 Active</span>
        <span><i className="dot warn" /> CART-02 Low</span>
        <span><i className="dot ok" /> CART-03 Active</span>
      </div>
    </div>
  );

  return (
    <div className="login-split">
      
      {/* --- MOBILE ONLY: Top Header --- */}
      <div className="login-mobile-header">
        <div className="login-mobile-content">
          <div className="login-logo-header">
            <img src="/logo.png" alt="CartIQ Logo" className="logo-icon-large" />
            <span style={{ fontSize: "24px", fontWeight: "800", color: "var(--text)" }}>CartIQ</span>
          </div>
          <TiltedPreviewCard className="mobile-card" />
        </div>
      </div>

      {/* --- KALIWA: Form Section (50%) --- */}
      <div className="login-form-side">
        <div className="login-form-container">
          
          <div className="login-logo-desktop">
            <img src="/logo.png" alt="CartIQ Logo" className="logo-icon-medium" />
            <strong style={{ fontSize: "20px", color: "var(--text)" }}>CartIQ</strong>
          </div>

          <div className="login-form-header">
            <h1 className="login-form-title">Welcome back</h1>
            <p className="login-form-subtitle">
              Protected operations POS portal.
            </p>
          </div>

          {error && (
            <div className="error-box login-error" role="alert" id="login-error">
              <XCircle size={18} className="error-icon" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} aria-label="Sign in to CartIQ" onKeyDown={(e) => { if (e.key === "Escape") setError(""); }}>
            
            <div className="input-group">
              <label htmlFor="login-username" className="field-label">Username</label>
              <div className="input-wrapper">
                <User className={`input-icon ${userFocused ? "focused" : ""}`} size={20} />
                <input
                  id="login-username"
                  name="username"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  onFocus={() => setUserFocused(true)}
                  onBlur={() => setUserFocused(false)}
                  placeholder="admin"
                  autoComplete="username"
                  required
                />
              </div>
            </div>

            <div className="input-group">
              <label htmlFor="login-password" className="field-label">Password</label>
              <div className="input-wrapper">
                <Lock className={`input-icon ${passwordFocused ? "focused" : ""}`} size={20} />
                <input
                  id="login-password"
                  name="password"
                  ref={passwordRef}
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onFocus={() => setPasswordFocused(true)}
                  onBlur={() => setPasswordFocused(false)}
                  onKeyUp={(e) => setCapsOn(!!e.getModifierState?.("CapsLock"))}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  required
                />
                <button
                  type="button"
                  className="password-toggle"
                  onClick={() => setShowPassword((s) => !s)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
                </button>
              </div>
            </div>

            {capsOn && !error && (
              <p className="muted small login-caps" role="status">
                Caps Lock is on.
              </p>
            )}

            <button type="submit" className="login-submit-btn" disabled={loading}>
              <span className="btn-slide-bg" />
              <span className="btn-content">
                {loading ? (
                  <>
                    <span className="btn-spinner" /> Verifying
                  </>
                ) : (
                  <>
                    Sign In <ArrowRight size={20} className="btn-arrow" />
                  </>
                )}
              </span>
            </button>
          </form>

          <div className="login-security-badge">
            <Shield size={14} />
            <span>Enterprise-grade security</span>
          </div>

          <div className="login-demo-hint">
            <Badge variant="info">DEV</Badge>
            <span>Local build — <button type="button" className="linklike" onClick={() => { setUsername("owner"); setPassword("owner123"); setError(""); }}>try the demo</button></span>
          </div>
          
          <div className="login-footer">
             v{APP_VERSION} • CartIQ Corporation
          </div>
        </div>
      </div>

      {/* --- KANAN: Brand / Hero Section (50%) --- */}
      <div className="login-brand-side">
        
        {/* Layer 1: Animated Blurred Orbs Background */}
        <div className="blur-orbs">
          <div className="orb orb-1" />
          <div className="orb orb-2" />
          <div className="orb orb-3" />
        </div>

        {/* Layer 2: Main Content */}
        <div className="login-brand-content">
          
          <div className="login-hero-text">
            <h2>Command Center</h2>
            <p>Manage sales, inventory, and staff across all your carts.</p>
          </div>
          
          <div className="login-tilted-wrapper">
            <div className="floating-pill pill-1">
              <span className="pill-dot" /> All Systems Operational
            </div>
            
            <TiltedPreviewCard className="desktop-card glass-panel" />
            
            <div className="floating-pill pill-2">
              <Zap size={16} color="var(--highlight)" fill="var(--highlight)" /> 
              <span><strong>Live</strong> IoT Sync</span>
            </div>
          </div>

          {/* Cleaned Quote, Centered, No Citation */}
          <div className="login-quote">
            “We see every cart's day before dinner. It completely changed our operations.”
          </div>
          
        </div>
      </div>

    </div>
  );
}