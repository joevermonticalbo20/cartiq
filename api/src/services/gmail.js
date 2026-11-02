// Gmail API sender (forgot-password OTP delivery).
//
// Uses the Gmail REST API over HTTPS (not SMTP) so the SAME module works in
// both runtimes: Node (Express, global fetch) and Deno (Supabase Edge).
// Supabase Edge Functions cannot open raw SMTP connections, which is why
// nodemailer-style SMTP is deliberately not used here.
//
// Setup (one time, by the team):
//   1. Google Cloud project -> enable the Gmail API.
//   2. OAuth 2.0 Client (Desktop) -> client ID + client secret.
//   3. OAuth Playground (https://developers.google.com/oauthplayground):
//      select the Gmail API v1 `gmail.send` scope, authorize the sender
//      account, exchange for a refresh token.
//   4. Store the four values as env vars (local .env) / Supabase secrets.
//      Publish the OAuth consent screen to "In production" BEFORE generating
//      the token: a token issued while the app is in "Testing" expires after
//      7 days. Google also expires a refresh token after six months without
//      use, so deploy-functions.yml exchanges it monthly as a keepalive.
//
// Env: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_FROM.
// EMAIL_PROVIDER=console prints codes locally (never allowed in production).

import {
  OTP_PURPOSE_CHANGE,
  OTP_PURPOSE_RESET,
  isPlaceholderEmail,
  maskEmail,
} from "./password_reset.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

let _cached = null; // { token, expMs }

function envValue(key) {
  // Deno/Edge reads Deno.env; Node reads process.env. The Deno branch is kept
  // for the unit-test seam even though production Edge has its own mirror.
  try {
    if (typeof Deno !== "undefined" && Deno.env) {
      return Deno.env.get(key) ?? "";
    }
  } catch {
    // Deno.env denied -> fall through to process.env.
  }
  return typeof process !== "undefined" && process.env
    ? process.env[key] ?? ""
    : "";
}

function gmailEnv() {
  return {
    clientId: envValue("GMAIL_CLIENT_ID"),
    clientSecret: envValue("GMAIL_CLIENT_SECRET"),
    refreshToken: envValue("GMAIL_REFRESH_TOKEN"),
    from: envValue("GMAIL_FROM"),
  };
}

export function gmailConfigured() {
  const { clientId, clientSecret, refreshToken, from } = gmailEnv();
  return Boolean(clientId && clientSecret && refreshToken && from);
}

/**
 * "gmail" (HTTPS API) or "console" (local/offline; prints the code).
 * An explicit EMAIL_PROVIDER wins; otherwise use Gmail when configured,
 * falling back to console for a fresh local checkout.
 */
export function emailProvider() {
  const explicit = envValue("EMAIL_PROVIDER").trim().toLowerCase();
  if (explicit) return explicit;
  return gmailConfigured() ? "gmail" : "console";
}

export function emailProviderAllowed(provider = emailProvider()) {
  if (provider === "gmail") return true;
  if (provider === "console") return envValue("NODE_ENV") !== "production";
  return false;
}

function base64Url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getAccessToken() {
  if (_cached && _cached.expMs - 60000 > Date.now()) return _cached.token;
  const { clientId, clientSecret, refreshToken } = gmailEnv();
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Gmail is not configured (missing OAuth credentials)");
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:
      "grant_type=refresh_token" +
      "&client_id=" + encodeURIComponent(clientId) +
      "&client_secret=" + encodeURIComponent(clientSecret) +
      "&refresh_token=" + encodeURIComponent(refreshToken),
  });
  if (!res.ok) {
    throw new Error(`Gmail token exchange failed (HTTP ${res.status})`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error("Gmail token exchange returned no token");
  _cached = {
    token: data.access_token,
    expMs: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  };
  return _cached.token;
}

// Test seam: reset the cached access token between unit tests.
export function _resetGmailCacheForTests() {
  _cached = null;
}

/**
 * Diagnostics for the Gmail OTP sender (OWNER-only endpoint backing).
 * Reports presence booleans + a live token-exchange check — NEVER secret
 * values. Always HTTP 200 (auth failures are handled by the route layer).
 */
export async function gmailStatus() {
  const { clientId, clientSecret, refreshToken, from } = gmailEnv();
  const present = {
    clientId: Boolean(clientId),
    clientSecret: Boolean(clientSecret),
    refreshToken: Boolean(refreshToken),
    from: Boolean(from),
  };
  if (!present.clientId || !present.clientSecret || !present.refreshToken) {
    return { configured: false, present, exchange: "skipped" };
  }
  if (!present.from) {
    return {
      configured: false,
      present,
      exchange: "skipped",
      error: "GMAIL_FROM is missing",
    };
  }
  try {
    await getAccessToken();
    return { configured: true, present, exchange: "ok" };
  } catch (err) {
    return {
      configured: false,
      present,
      exchange: "failed",
      error: String(err?.message ?? err).slice(0, 200),
    };
  }
}

/**
 * Send a plain-text email from the configured Gmail account.
 * Throws on misconfiguration or API failure — callers (forgot-password)
 * catch, log server-side, and still return the generic success response.
 */
export async function sendGmail({ to, subject, text, html }) {
  const { from } = gmailEnv();
  if (!from) throw new Error("Gmail is not configured (missing GMAIL_FROM)");
  // Header values must never contain a line break (the body may).
  if (/[\r\n]/.test(String(to)) || /[\r\n]/.test(String(subject)) || /[\r\n]/.test(from)) {
    throw new Error("Invalid email header value");
  }
  const token = await getAccessToken();
  const boundary = html ? "cartiq_" + Math.random().toString(36).slice(2) : null;
  const raw = html
    ? [
        `From: ${from}`,
        `To: ${to}`,
        `Subject: ${subject}`,
        `MIME-Version: 1.0`,
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        "",
        `--${boundary}`,
        `Content-Type: text/plain; charset="UTF-8"`,
        "",
        text,
        `--${boundary}`,
        `Content-Type: text/html; charset="UTF-8"`,
        "",
        html,
        `--${boundary}--`,
      ].join("\\r\\n")
    : [
        `From: ${from}`,
        `To: ${to}`,
        `Subject: ${subject}`,
        `Content-Type: text/plain; charset="UTF-8"`,
        "",
        text,
      ].join("\\r\\n");
  const encoded = base64Url(new TextEncoder().encode(raw));
  const res = await fetch(SEND_URL, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw: encoded }),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = JSON.stringify(await res.json()).slice(0, 200);
    } catch {
      detail = "";
    }
    throw new Error(`Gmail send failed (HTTP ${res.status}) ${detail}`);
  }
  return true;
}

/** Build a beautiful HTML email for an OTP code. */
function otpEmailHtml(code, title, subtitle, securityMsg) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  body { margin: 0; padding: 0; background-color: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; }
  .wrapper { width: 100%; padding: 40px 16px; box-sizing: border-box; }
  .card { max-width: 480px; margin: 0 auto; background: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.06); }
  .header { background: linear-gradient(135deg, #e73631 0%, #c62828 100%); padding: 32px 24px; text-align: center; }
  .brand { font-size: 28px; font-weight: 800; color: #ffffff; letter-spacing: -0.5px; margin: 0; }
  .brand-sub { font-size: 13px; color: rgba(255,255,255,0.8); margin-top: 4px; }
  .logo-img { width: 56px; height: 56px; border-radius: 12px; margin-bottom: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
  .body { padding: 32px 24px; }
  .title { font-size: 20px; font-weight: 700; color: #1a1a1a; text-align: center; margin: 0 0 8px; }
  .subtitle { font-size: 15px; color: #555; text-align: center; margin: 0 0 24px; line-height: 1.5; }
  .code-container { background: #fafafa; border: 2px dashed #e73631; border-radius: 12px; padding: 24px 16px; text-align: center; margin: 24px 0; }
  .code { font-size: 40px; font-weight: 800; letter-spacing: 10px; color: #e73631; font-family: 'Courier New', Courier, monospace; margin: 0; }
  .expiry { font-size: 13px; color: #888; margin-top: 8px; }
  .security-box { background: #fff8f8; border: 1px solid #ffe0e0; border-radius: 8px; padding: 14px 16px; margin-top: 24px; }
  .security-box p { font-size: 13px; color: #666; margin: 0; line-height: 1.5; }
  .footer { text-align: center; padding: 20px 24px; border-top: 1px solid #f0f0f0; }
  .footer p { font-size: 12px; color: #999; margin: 0; }
</style>
</head>
<body>
  <div class="wrapper">
    <div class="card">
      <div class="header">
        <img src="https://cartiq-8e46f.web.app/logo.png" alt="CartIQ Logo" width="56" height="56" class="logo-img" />
        <p class="brand">CartIQ</p>
        <p class="brand-sub">Pota Fries Operations</p>
      </div>
      <div class="body">
        <h1 class="title">${title}</h1>
        <p class="subtitle">${subtitle}</p>
        <div class="code-container">
          <p class="code">${code}</p>
          <p class="expiry">Expires in 10 minutes</p>
        </div>
        <div class="security-box">
          <p>${securityMsg}</p>
        </div>
      </div>
      <div class="footer">
        <p>&copy; CartIQ &mdash; Pota Fries Operations</p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

/** Subject + body for a password-reset OTP. Kept here so both runtimes agree. */
export function resetEmailContent(code) {
  return {
    subject: "CartIQ password reset code",
    text:
      `Your CartIQ password reset code is:\\n\\n${code}\\n\\n` +
      `It expires in 10 minutes and can only be used once.\\n` +
      `If you didn't ask for this, you can ignore this email.\\n\\n` +
      `- CartIQ (Pota Fries Operations)`,
    html: otpEmailHtml(
      code,
      "Password Reset Code",
      "Use this code to reset your password. It expires in 10 minutes and can only be used once.",
      "🔒 If you didn't request this code, you can safely ignore this email. Your password won't change.",
    ),
  };
}

/** Subject + body for a signed-in password change. */
export function changeEmailContent(code) {
  return {
    subject: "CartIQ password change code",
    text:
      `Your CartIQ password change code is:\n\n${code}\n\n` +
      `It expires in 10 minutes and can only be used once.\n` +
      `If you didn't ask to change your password, your password was NOT changed.\n` +
      `You can ignore this email.\n\n` +
      `- CartIQ (Pota Fries Operations)`,
    html: otpEmailHtml(
      code,
      "Password Change Code",
      "Use this code to change your password. It expires in 10 minutes and can only be used once.",
      "🔒 If you didn't request this code, your password was NOT changed. You can safely ignore this email.",
    ),
  };
}

export function otpEmailContent(code, purpose = OTP_PURPOSE_RESET) {
  return purpose === OTP_PURPOSE_CHANGE
    ? changeEmailContent(code)
    : resetEmailContent(code);
}

/**
 * Deliver an OTP through the configured provider.
 * - console: logs the full message (local/offline only)
 * - gmail: sends through the Gmail HTTPS API; placeholder addresses are
 *   skipped because .local is not deliverable and must not hit Gmail.
 */
export async function sendOtpEmail({
  to,
  code,
  purpose = OTP_PURPOSE_RESET,
}) {
  const provider = emailProvider();
  if (!emailProviderAllowed(provider)) {
    throw new Error(
      provider === "console"
        ? "EMAIL_PROVIDER=console is disabled in production"
        : `Unknown EMAIL_PROVIDER "${provider}"`,
    );
  }
  const { subject, text, html } = otpEmailContent(code, purpose);
  if (provider === "console") {
    console.log(
      `[mail:console] To: ${to}\nSubject: ${subject}\n\n${text}\n`,
    );
    return { provider, sent: false, logged: true };
  }
  if (!to) throw new Error("OTP recipient is missing");
  if (isPlaceholderEmail(to)) {
    console.warn(
      `[mail:gmail] skipped placeholder recipient ${maskEmail(to)} - set a real recovery email`,
    );
    return { provider, sent: false, placeholder: true };
  }
  await sendGmail({ to, subject, text, html });
  return { provider, sent: true };
}

/** Diagnostics for the owner endpoint: provider + Gmail token exchange. */
export async function emailStatus() {
  const provider = emailProvider();
  return {
    provider,
    allowed: emailProviderAllowed(provider),
    ...(await gmailStatus()),
  };
}
