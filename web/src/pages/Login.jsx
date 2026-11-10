import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Eye, EyeOff, User, Lock, ArrowRight, Shield, Zap } from "lucide-react";
import api, { writeSession } from "../api.js";
import { getFriendlyError } from "../utils/errors.js";
import {
  attemptsRemainingFromError,
  formatLockCountdown,
  lockoutSecondsFromError,
} from "../utils/loginLockout.js";
import ErrorBox from "../components/ErrorBox.jsx";
import RecoveryFlow from "./RecoveryFlow.jsx";

const APP_VERSION = import.meta.env.VITE_APP_VERSION || "0.1.0";

const WEEKDAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];

/** Weekday letter (S M T W T F S) for a "YYYY-MM-DD" calendar date. */
function weekdayLetter(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ""));
  if (!m) return "";
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return WEEKDAY_LETTERS[d.getUTCDay()];
}

/**
 * The last 7 days of sales as chart bars.
 *
 * Real numbers from the server - the preview used to draw made-up bars
 * ([38, 62, 48, ...]) that looked like a weekly chart but were mock data.
 * A day with no sales still gets a small baseline so the axis reads right.
 */
function buildWeeklyBars(weekly) {
  const rows = Array.isArray(weekly) ? weekly : [];
  if (rows.length === 0) return [];
  const values = rows.map((r) => Number(r?.total_sales) || 0);
  const max = Math.max(...values, 0);
  const peakIndex = max > 0 ? values.indexOf(max) : -1;
  return rows.map((r, i) => {
    const value = values[i];
    const height = max > 0 ? Math.max(4, Math.round((value / max) * 100)) : 4;
    return {
      date: r?.date ?? "",
      value,
      label: weekdayLetter(r?.date),
      height,
      isPeak: i === peakIndex,
    };
  });
}

function TiltedPreviewCard({ className = "", salesToday }) {
  const totalSales = salesToday?.total_sales;
  const orderCount = Number.isFinite(Number(salesToday?.orders))
    ? Number(salesToday.orders)
    : null;
  const previewCarts = Array.isArray(salesToday?.carts) ? salesToday.carts : [];
  const weeklyBars = buildWeeklyBars(salesToday?.weekly);
  const previewStatusMeta = {
    ok: { label: "Active", className: "ok" },
    low: { label: "Low", className: "warn" },
    critical: { label: "Critical", className: "bad" },
  };

  return (
    <div className={`login-preview ${className}`} aria-hidden="true">
      <div className="login-preview-header">
        <span className="login-preview-label">SALES TODAY</span>
        <div className="login-preview-row">
          <strong className="login-preview-value">
            {totalSales == null
              ? "—"
              : `P${Number(totalSales).toLocaleString(undefined, {
                  minimumFractionDigits: 0,
                  maximumFractionDigits: 2,
                })}`}
          </strong>
          <span className="login-preview-trend">
            {orderCount == null ? "" : `${orderCount} order${orderCount === 1 ? "" : "s"}`}
          </span>
        </div>
      </div>
      {weeklyBars.length > 0 && (
        <div className="login-preview-chart-area">
          <div className="login-preview-bars">
            {weeklyBars.map((bar) => (
              <div
                key={bar.date}
                className="login-preview-barcol"
                style={{ "--h": `${bar.height}%` }}
                title={`${bar.date}: P${bar.value.toLocaleString()}`}
              >
                {bar.isPeak && <span className="login-preview-peak">PEAK</span>}
                <div className={`bar-wrapper${bar.isPeak ? " peak" : ""}`}>
                  <span className="bar" />
                </div>
                <span className="bar-label">{bar.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="login-preview-carts">
        {previewCarts.slice(0, 3).map((cart) => {
          const meta = previewStatusMeta[cart.status] ?? previewStatusMeta.ok;
          return (
            <span key={cart.code}>
              <i className={`dot ${meta.className}`} /> {cart.code} {meta.label}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export default function Login() {
  const navigate = useNavigate();
  
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [capsOn, setCapsOn] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loginError, setLoginError] = useState("");
  // Remember me (default on): unchecked scopes the session to this tab via
  // sessionStorage instead of persistent localStorage.
  const [remember, setRemember] = useState(true);
  // Inline recovery: the form side swaps the login form for the shared
  // RecoveryFlow (brand side stays put) instead of navigating away.
  const [mode, setMode] = useState("login");
  const [userFocused, setUserFocused] = useState(false);
  const [passwordFocused, setPasswordFocused] = useState(false);
  const [salesToday, setSalesToday] = useState(null);
  // Server lockout is per username. Track which username it belongs to so
  // another staff member can sign in on the same shared device.
  const [lockoutUntilMs, setLockoutUntilMs] = useState(null);
  const [lockoutSeconds, setLockoutSeconds] = useState(0);
  const [lockoutUsername, setLockoutUsername] = useState("");
  const passwordRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const loadSalesToday = async () => {
      try {
        // 15s: the preview is live (a sale must show up right away), but it
        // must not hammer the API on every page load.
        const { data } = await api.get("/public/sales-today", { cacheTtl: 15000 });
        if (!cancelled) setSalesToday(data ?? null);
      } catch {
        if (!cancelled) setSalesToday(null);
      }
    };
    const timer = setTimeout(loadSalesToday, 0);
    // Keep the preview live: a sale that lands while the login screen is open
    // must show up without a manual reload.
    const refresh = setInterval(loadSalesToday, 30000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearInterval(refresh);
    };
  }, []);

  useEffect(() => {
    if (!lockoutUntilMs) return undefined;
    const tick = () => {
      const remaining = Math.max(
        0,
        Math.ceil((lockoutUntilMs - Date.now()) / 1000)
      );
      setLockoutSeconds(remaining);
      if (remaining <= 0) {
        setLockoutUntilMs(null);
        setLockoutUsername("");
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [lockoutUntilMs]);

  function clearLockout() {
    setLockoutUntilMs(null);
    setLockoutSeconds(0);
    setLockoutUsername("");
  }

  const lockedForThisUser =
    lockoutSeconds > 0 &&
    lockoutUsername !== "" &&
    lockoutUsername === username.trim();

  async function handleSubmit(e) {
    e.preventDefault();
    if (lockedForThisUser) {
      setLoginError(
        `Too many failed attempts. Wait ${formatLockCountdown(lockoutSeconds)} and try again.`
      );
      return;
    }
    setLoading(true);
    setLoginError("");
    try {
      const { data } = await api.post("/auth/login", { username, password });
      writeSession({
        token: data.token,
        refreshToken: data.refreshToken,
        remember,
      });
      // Warm the next routes while the operator is still on this screen, so
      // navigating after login is as close to instant as the network allows.
      // Fire-and-forget: a chunk failure must not break the login.
      import("./DashboardPage.jsx").catch(() => {});
      import("./SalesPage.jsx").catch(() => {});
      import("./InventoryPage.jsx").catch(() => {});
      import("./ProductsPage.jsx").catch(() => {});
      navigate("/dashboard");
    } catch (err) {
      const status = err?.status ?? err?.response?.status ?? null;
      const retryAfter = lockoutSecondsFromError(err);
      const attemptsLeft = attemptsRemainingFromError(err);

      if (status === 429 && retryAfter > 0) {
        // The server owns the 5-minute policy; the browser only counts down
        // the seconds it returned, so a reload or another tab stays honest.
        setLockoutUntilMs(Date.now() + retryAfter * 1000);
        setLockoutSeconds(retryAfter);
        setLockoutUsername(username.trim());
        setLoginError("");
      } else {
        let message = getFriendlyError(
          err,
          "We couldn't sign you in. Check your username and password, then try again."
        );
        if (attemptsLeft === 0) {
          message += " The next attempt will be blocked for 5 minutes.";
        } else if (attemptsLeft !== null) {
          message += ` ${attemptsLeft} attempt${attemptsLeft === 1 ? "" : "s"} left before a 5-minute lock.`;
        }
        setLoginError(message);
      }
      passwordRef.current?.focus();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-split">
      {/* --- MOBILE ONLY: Top Header --- */}
      <div className="login-mobile-header">
        <div className="login-mobile-content">
          <div className="login-logo-header">
            <img src="/logo.png" alt="CartIQ Logo" className="logo-icon-large" />
            <span style={{ fontSize: "24px", fontWeight: "800", color: "var(--text)" }}>CartIQ</span>
          </div>
          <TiltedPreviewCard className="mobile-card" salesToday={salesToday} />
        </div>
      </div>

      {/* --- KALIWA: Form Section (50%) --- */}
      <div className="login-form-side">
        <div className="login-form-container">
          <div className="login-logo-desktop">
            <img src="/logo.png" alt="CartIQ Logo" className="logo-icon-medium" />
            <strong style={{ fontSize: "20px", color: "var(--text)" }}>CartIQ</strong>
          </div>

          {mode === "recovery" ? (
            <RecoveryFlow onExitToLogin={() => setMode("login")} />
          ) : (
          <>
          <div className="login-form-header">
            <h1 className="login-form-title">Welcome back</h1>
            <p className="login-form-subtitle">
              Protected operations POS portal.
            </p>
          </div>

          <form onSubmit={handleSubmit} aria-label="Sign in to CartIQ">
            <div className="input-group">
              <label htmlFor="login-username" className="field-label">Username</label>
              <div className="input-wrapper">
                <User className={`input-icon ${userFocused ? "focused" : ""}`} size={20} />
                <input
                  id="login-username"
                  name="username"
                  type="text"
                  value={username}
                  onChange={(e) => {
                    setUsername(e.target.value);
                    // A lock belongs to the account, not the device. Switching
                    // usernames lets the next staff member try immediately.
                    if (lockoutUsername && e.target.value.trim() !== lockoutUsername) {
                      clearLockout();
                    }
                  }}
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

            {capsOn && (
              <p className="muted small login-caps" role="status">
                Caps Lock is on.
              </p>
            )}

            <ErrorBox
              message={
                lockedForThisUser
                  ? `Too many failed attempts. Wait ${formatLockCountdown(lockoutSeconds)} and try again.`
                  : loginError
              }
              style={{ marginBottom: "var(--space-3)" }}
            />

            <button
              type="submit"
              className="login-submit-btn"
              disabled={loading || lockedForThisUser}
            >
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
            <div className="login-remember-row">
              <label className="login-remember">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                />
                Remember me
              </label>
              <button type="button" className="login-forgot-link" onClick={() => setMode("recovery")}>
                Forgot password?
              </button>
            </div>
          </form>
          </>
          )}

          <div className="login-security-badge">
            <Shield size={14} />
            <span>Enterprise-grade security</span>
          </div>

          <div className="login-footer">
             v{APP_VERSION} • CartIQ Corporation
          </div>
        </div>
      </div>

      {/* --- KANAN: Brand / Hero Section (50%) --- */}
      <div className="login-brand-side">
        <div className="blur-orbs">
          <div className="orb orb-1" />
          <div className="orb orb-2" />
          <div className="orb orb-3" />
        </div>

        <div className="login-brand-content">
          <div className="login-hero-text">
            <h2>Command Center</h2>
            <p>Manage sales, inventory, and staff across all your carts.</p>
          </div>
          
          <div className="login-tilted-wrapper">
            <div className="floating-pill pill-1">
              <span className="pill-dot" /> All Systems Operational
            </div>
            
            <TiltedPreviewCard className="desktop-card glass-panel" salesToday={salesToday} />
            
            <div className="floating-pill pill-2">
              <Zap size={16} color="var(--highlight)" fill="var(--highlight)" /> 
              <span><strong>Live</strong> IoT Sync</span>
            </div>
          </div>

          <div className="login-quote">
            &ldquo;We see every cart&rsquo;s day before dinner. It completely changed our operations.&rdquo;
          </div>
        </div>
      </div>
    </div>
  );
}