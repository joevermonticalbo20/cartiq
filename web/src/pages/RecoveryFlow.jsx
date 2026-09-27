import { useRef, useState } from "react";
import { ArrowLeft, Mail, ShieldCheck, Lock } from "lucide-react";
import api from "../api.js";
import { getFriendlyError } from "../utils/errors.js";
import ErrorBox from "../components/ErrorBox.jsx";

const CODE_LEN = 6;

/**
 * Account recovery flow: email -> 6-digit Gmail OTP -> new password.
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const boxRefs = useRef([]);

  async function sendCode(e) {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      // Generic success either way (no enumeration); always advance.
      await api.post("/auth/forgot-password", { email });
      setSentTo(email.trim());
      setCode("");
      setVerified(false);
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
            {verified ? (
              <button type="button" className="login-submit-btn" onClick={() => { setError(""); setStep(3); }}>
                <span className="btn-content">Continue</span>
              </button>
            ) : (
              <button type="submit" className="login-submit-btn" disabled={busy}>
                <span className="btn-content">{busy ? "Verifying..." : "Verify Code"}</span>
              </button>
            )}
          </form>
          <p className="muted small" style={{ textAlign: "center", marginTop: "var(--space-3)" }}>
            Didn&apos;t receive code?{" "}
            <button type="button" className="linklike" onClick={sendCode} disabled={busy}>
              {busy ? "Sending..." : "Resend"}
            </button>
          </p>
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
                  type="password"
                  required
                  minLength={8}
                  autoFocus
                  value={pw}
                  onChange={(e) => setPw(e.target.value)}
                  placeholder="Create New Password"
                  autoComplete="new-password"
                />
              </div>
            </div>
            <div className="input-group">
              <label htmlFor="recovery-pw2" className="field-label">Confirm New Password</label>
              <div className="input-wrapper">
                <Lock size={20} className="input-icon" />
                <input
                  id="recovery-pw2"
                  type="password"
                  required
                  value={pw2}
                  onChange={(e) => setPw2(e.target.value)}
                  placeholder="Confirm New Password"
                  autoComplete="new-password"
                />
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
