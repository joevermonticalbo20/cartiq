import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Eye, EyeOff, Mail, ShieldCheck, Lock } from "lucide-react";
import api from "../api.js";
import { getFriendlyError } from "../utils/errors.js";
import { executeRecaptcha, recaptchaEnabled } from "../utils/recaptcha.js";
import ErrorBox from "../components/ErrorBox.jsx";
import PasswordStrengthMeter, { evaluatePassword } from "../components/PasswordStrengthMeter.jsx";

const CODE_LEN = 6;

/**
 * Account recovery flow: email -> 6-digit email OTP -> new password.
 * Three explicit steps with a STEP X OF 3 pill, back links, and a
 * verify-before-password gate: POST /auth/verify-reset-code confirms the
 * code without consuming it, POST /auth/reset-password redeems it. All
 * failures stay generic so the flow can't oracle valid codes or
 * registered emails.
 *
 * Rendered in two frames sharing this logic: inline inside the login form
 * side (`Login.jsx`) and standalone on the `/forgot-password` route.
 * `onExitToLogin` returns the user to the login form in both frames.
 */
export default function RecoveryFlow({ onExitToLogin }) {
  const [step, setStep] = useState(1);
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState("");
  const [code, setCode] = useState("");
  const [verified, setVerified] = useState(false);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [showPw2, setShowPw2] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  // Set when the server locked this address out (too many codes requested).
  const [lockoutSeconds, setLockoutSeconds] = useState(0);
  const isLockedOut = lockoutSeconds > 0;
  const boxRefs = useRef([]);

  // Countdown for the resend cooldown (60s, matching the backend).
  useEffect(() => {
    if (resendCooldown <= 0 && lockoutSeconds <= 0) return undefined;
    const timer = setTimeout(() => {
      setResendCooldown((s) => Math.max(0, s - 1));
      setLockoutSeconds((s) => Math.max(0, s - 1));
    }, 1000);
    return () => clearTimeout(timer);
  }, [resendCooldown, lockoutSeconds]);

  async function sendCode(e) {
    e?.preventDefault();
    if (busy) return;
    if (resendCooldown > 0) return;
    setBusy(true);
    setError("");
    try {
      // Generic success either way (no enumeration); always advance. If the
      // server demands a CAPTCHA because this traffic looks suspicious, solve
      // it and retry once.
      let data;
      try {
        const res = await api.post("/auth/forgot-password", { email });
        data = res.data;
      } catch (err) {
        if (err?.code === "CAPTCHA_REQUIRED" && recaptchaEnabled()) {
          const captchaToken = await executeRecaptcha("otp_request");
          const res = await api.post("/auth/forgot-password", { email, captchaToken });
          data = res.data;
        } else {
          throw err;
        }
      }
      setSentTo(email.trim());
      setCode("");
      setVerified(false);
      // The server owns the timing: it says how long is left of the 60s
      // cooldown, and how long the address is locked out when the cap was
      // reached. The countdown follows the server, not a guess.
      const retryMs = Number(data?.retryAfterMs ?? 0);
      const lockedUntilMs = data?.lockedUntil
        ? typeof data.lockedUntil === "number"
          ? data.lockedUntil
          : new Date(data.lockedUntil).getTime()
        : 0;
      if (lockedUntilMs > 0) {
        const seconds = Math.max(0, Math.ceil((lockedUntilMs - Date.now()) / 1000));
        setLockoutSeconds(seconds);
        setResendCooldown(seconds);
      } else {
        setLockoutSeconds(0);
        setResendCooldown(Math.ceil(retryMs / 1000) || 60);
      }
      setStep(2);
    } catch (err) {
      setError(getFriendlyError(err, "Couldn't send a reset code - try again."));
    } finally {
      setBusy(false);
    }
  }

  function setCodeAt(i, ch) {
    const digit = String(ch ?? "").replace(/\D/g, "").slice(-1);
    setCode((prev) => {
      const next = (prev + "      ").slice(0, CODE_LEN).split("");
      if (digit) next[i] = digit;
      else next[i] = " ";
      return next.join("").trimEnd();
    });
    if (digit && i < CODE_LEN - 1) boxRefs.current[i + 1]?.focus();
  }

  function handleBoxKey(i, e) {
    if (e.key === "Backspace" && !code[i] && i > 0) {
      boxRefs.current[i - 1]?.focus();
    }
  }

  function handlePaste(e) {
    const digits = (e.clipboardData?.getData("text") ?? "").replace(/\D/g, "").slice(0, CODE_LEN);
    if (!digits) return;
    e.preventDefault();
    setCode(digits);
    boxRefs.current[Math.min(digits.length, CODE_LEN - 1)]?.focus();
  }

  async function verifyCode(e) {
    e?.preventDefault();
    if (busy) return;
    if (code.length !== CODE_LEN) {
      setError("Enter the 6-digit code.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.post("/auth/verify-reset-code", { email: sentTo, code });
      setVerified(true);
      // Auto-advance to the password step once the code is verified.
      setStep(3);
    } catch (err) {
      setVerified(false);
      setError(getFriendlyError(err, "Couldn't verify the code - try again."));
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword(e) {
    e.preventDefault();
    if (pw !== pw2) {
      setError("New passwords do not match.");
      return;
    }
    const { level } = evaluatePassword(pw);
    if (!["good", "strong"].includes(level)) {
      setError("Password must be at least 'Good' strength (8+ chars, upper/lower, number, special).");
      return;
    }
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api.post("/auth/reset-password", {
        email: sentTo,
        code,
        newPassword: pw,
      });
      setDone(true);
    } catch (err) {
      setError(getFriendlyError(err, "Couldn't reset the password - check the code and try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="recovery-eyebrow">
        <span className="muted small">Account Recovery</span>
        <span className="step-pill" aria-label={`Step ${done ? 3 : step} of 3`}>
          STEP {done ? 3 : step} OF 3
        </span>
      </div>

      {step > 1 && !done ? (
        <button type="button" className="recovery-back" onClick={() => { setError(""); setStep((s) => s - 1); }}>
          <ArrowLeft size={16} /> Go Back
        </button>
      ) : (
        <button type="button" className="recovery-back" onClick={onExitToLogin}>
          <ArrowLeft size={16} /> Back to Login
        </button>
      )}

      {!done && step === 1 && (
        <>
          <h1 className="login-form-title">Forgot Password?</h1>
          <p className="login-form-subtitle">
            Enter your email address and we&apos;ll send you a 6-digit code to reset your password.
          </p>
          <form onSubmit={sendCode} aria-label="Send reset code">
            <div className="input-group">
              <label htmlFor="recovery-email" className="field-label">Email Address</label>
              <div className="input-wrapper">
                <Mail size={20} className="input-icon" />
                <input
                  id="recovery-email"
                  type="email"
                  required
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                />
              </div>
            </div>
            <ErrorBox message={error} style={{ marginBottom: "var(--space-3)" }} />
            <button type="submit" className="login-submit-btn" disabled={busy}>
              <span className="btn-content">{busy ? "Sending..." : "Send Reset Code"}</span>
            </button>
          </form>
        </>
      )}

      {!done && step === 2 && (
        <>
          <h1 className="login-form-title">Check Email</h1>
          <p className="login-form-subtitle">
            We sent a verification code to <strong>{sentTo}</strong>. Please enter it below to proceed.
          </p>
          {verified && (
            <p className="recovery-verified" role="status">
              <ShieldCheck size={16} /> Code verified! You can now reset your password.
            </p>
          )}
          <form onSubmit={verifyCode} aria-label="Verify reset code">
            <div
              className="recovery-codeboxes"
              onPaste={handlePaste}
              role="group"
              aria-label="6-digit verification code"
            >
              {Array.from({ length: CODE_LEN }, (_, i) => (
                <input
                  key={i}
                  ref={(el) => (boxRefs.current[i] = el)}
                  className="recovery-codebox"
                  inputMode="numeric"
                  autoComplete={i === 0 ? "one-time-code" : "off"}
                  aria-label={`Digit ${i + 1}`}
                  maxLength={1}
                  value={code[i] ?? ""}
                  onChange={(e) => setCodeAt(i, e.target.value)}
                  onKeyDown={(e) => handleBoxKey(i, e)}
                />
              ))}
            </div>
            <ErrorBox message={error} style={{ marginBottom: "var(--space-3)" }} />
            {!verified && (
              <button type="submit" className="login-submit-btn" disabled={busy}>
                <span className="btn-content">{busy ? "Verifying..." : "Verify Code"}</span>
              </button>
            )}
          </form>
          <p className="muted small" style={{ textAlign: "center", marginTop: "var(--space-3)" }}>
            Didn&apos;t receive code?{" "}
            <button
              type="button"
              className="linklike"
              onClick={sendCode}
              disabled={busy || resendCooldown > 0}
            >
              {busy
                ? "Sending..."
                : isLockedOut
                  ? `Try again in ${resendCooldown}s`
                  : resendCooldown > 0
                    ? `Resend in ${resendCooldown}s`
                    : "Resend"}
            </button>
          </p>
          {isLockedOut && (
            <p className="muted small" style={{ textAlign: "center" }}>
              Too many codes were requested for this address. You can ask for another one in{" "}
              {Math.max(1, Math.ceil(lockoutSeconds / 60))} minute(s).
            </p>
          )}
        </>
      )}

      {!done && step === 3 && (
        <>
          <h1 className="login-form-title">New Password</h1>
          <p className="login-form-subtitle">
            Ensure your new password is at least 8 characters long for better security.
          </p>
          <form onSubmit={resetPassword} aria-label="Set new password">
            <div className="input-group">
              <label htmlFor="recovery-pw" className="field-label">Create New Password</label>
              <div className="input-wrapper">
                <Lock size={20} className="input-icon" />
                <input
                  id="recovery-pw"
                  type={showPw ? "text" : "password"}
                  required
                  minLength={8}
                  autoFocus
                  value={pw}
                  onChange={(e) => setPw(e.target.value)}
                  placeholder="Create New Password"
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  className="password-toggle"
                  onClick={() => setShowPw((s) => !s)}
                  aria-label={showPw ? "Hide password" : "Show password"}
                >
                  {showPw ? <EyeOff size={20} /> : <Eye size={20} />}
                </button>
              </div>
              <PasswordStrengthMeter value={pw} minLevel="good" />
            </div>
            <div className="input-group">
              <label htmlFor="recovery-pw2" className="field-label">Confirm New Password</label>
              <div className="input-wrapper">
                <Lock size={20} className="input-icon" />
                <input
                  id="recovery-pw2"
                  type={showPw2 ? "text" : "password"}
                  required
                  value={pw2}
                  onChange={(e) => setPw2(e.target.value)}
                  placeholder="Confirm New Password"
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  className="password-toggle"
                  onClick={() => setShowPw2((s) => !s)}
                  aria-label={showPw2 ? "Hide password" : "Show password"}
                >
                  {showPw2 ? <EyeOff size={20} /> : <Eye size={20} />}
                </button>
              </div>
            </div>
            <ErrorBox message={error} style={{ marginBottom: "var(--space-3)" }} />
            <button type="submit" className="login-submit-btn" disabled={busy}>
              <span className="btn-content">{busy ? "Saving..." : "Reset Password"}</span>
            </button>
          </form>
        </>
      )}

      {done && (
        <>
          <h1 className="login-form-title">Password updated</h1>
          <p className="login-form-subtitle">
            Your password was reset. Sign in with your new password.
          </p>
          <p className="recovery-verified" role="status">
            <ShieldCheck size={16} /> All other sessions were signed out.
          </p>
          <button type="button" className="login-submit-btn" onClick={onExitToLogin}>
            <span className="btn-content">Back to Login</span>
          </button>
        </>
      )}
    </>
  );
}
