import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Eye, EyeOff, XCircle } from "lucide-react";
import api from "../api.js";

const APP_VERSION = import.meta.env.VITE_APP_VERSION || "0.1.0";

export default function Login() {
  const navigate = useNavigate();  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [capsOn, setCapsOn] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
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
      // Move focus to the field that needs attention.
      passwordRef.current?.focus();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-split">
      <div className="login-brand">
        <div className="logo-mark login-brand-mark">CQ</div>
        <h1 className="login-brand-title">Fresh sales,<br />hot off the cart.</h1>
        <div className="login-brand-rule" aria-hidden="true" />
        <p className="login-brand-sub">
          Cart<em>IQ</em> — Pota Fries Operations
          <br />
          Multi-cart analytics &amp; POS
        </p>
        <div className="login-preview" aria-hidden="true">
          <div className="login-preview-card">
            <span className="login-preview-label">SALES TODAY</span>
            <strong className="login-preview-value">P12,450</strong>
            <span className="login-preview-trend">+8.2% vs yesterday</span>
          </div>
          <div className="login-preview-bars">
            {[38, 62, 48, 78, 58, 92, 70].map((h, i) => (
              <span key={i} style={{ height: `${h}%` }} />
            ))}
          </div>
          <div className="login-preview-carts">
            <span><i className="dot ok pulse" /> CART-01 · Selling now</span>
            <span><i className="dot warn" /> CART-02</span>
            <span><i className="dot ok" /> CART-03</span>
          </div>
        </div>
        <blockquote className="login-quote">
          “We see every cart&apos;s day before dinner.”
          <cite>— Cart owner, pilot outlet</cite>
        </blockquote>
      </div>
      <div className="center-wrap login-form-side">
      <form
        className="card login-card"
        onSubmit={handleSubmit}
        aria-label="Sign in to CartIQ"
        onKeyDown={(e) => {
          if (e.key === "Escape") setError("");
        }}
      >
        <h1>Welcome back</h1>
        <p className="muted">Sign in to the admin dashboard</p>
        <label htmlFor="login-username" className="field">
          Username
          <input
            id="login-username"
            name="username"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Username"
            autoComplete="username"
            autoFocus
            required
          />
        </label>
        <label htmlFor="login-password" className="field">
          Password
          <div className="password-field">
            <input
              id="login-password"
              name="password"
              ref={passwordRef}
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyUp={(e) => setCapsOn(!!e.getModifierState?.("CapsLock"))}
              onBlur={() => setCapsOn(false)}
              placeholder="••••••••"
              autoComplete="current-password"
              aria-describedby={error ? "login-error" : undefined}
              required
            />
            <button
              type="button"
              className="password-toggle"
              onClick={() => setShowPassword((s) => !s)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
              title={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
        </label>
        {capsOn && !error && (
          <p className="muted small login-caps" role="status">
            Caps Lock is on — passwords are case-sensitive.
          </p>
        )}
        {error && (
          <div className="error-box login-error" role="alert" id="login-error">
            <XCircle size={16} aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}
        <button className="login-submit" disabled={loading}>
          {loading ? (
            <>
              <span className="btn-spinner" aria-hidden="true" />
              Verifying…
            </>
          ) : (
            "Sign in"
          )}
        </button>
        <p className="muted small login-hint">
          <span className="chip info">DEV</span>
          <span>Local build — <button type="button" className="linklike" onClick={() => { setUsername("owner"); setPassword("owner123"); setError(""); }}>try the demo</button></span>
        </p>
        <p className="muted small login-trust">Protected outlet login · v{APP_VERSION}</p>
      </form>
      </div>
    </div>
  );
}