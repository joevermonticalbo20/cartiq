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
  OTP_PURPOSE_VERIFY,
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

/**
 * Encode a MIME header value (RFC 2047).
 *
 * A subject like "Verify your email — CartIQ" carries an em dash. Written
 * raw into the header, its UTF-8 bytes are read as latin-1 by the mail client
 * and the subject arrives as "â€"". ASCII is left alone; anything else is
 * encoded as "=?UTF-8?B?...?=".
 */
export function encodeMimeHeader(value) {
  const s = String(value ?? "");
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  const bytes = new TextEncoder().encode(s);
  return `=?UTF-8?B?${Buffer.from(bytes).toString("base64")}?=`;
}

/** Same, but for an address: only the display name is encoded. */
export function encodeAddressHeader(value) {
  const s = String(value ?? "").trim();
  const m = /^(.*)<([^>]+)>$/.exec(s);
  if (!m) return encodeMimeHeader(s);
  const name = m[1].trim().replace(/^"|"$/g, "");
  return `${encodeMimeHeader(name)} <${m[2]}>`;
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
        `From: ${encodeAddressHeader(from)}`,
        `To: ${encodeAddressHeader(to)}`,
        `Subject: ${encodeMimeHeader(subject)}`,
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
        `From: ${encodeAddressHeader(from)}`,
        `To: ${encodeAddressHeader(to)}`,
        `Subject: ${encodeMimeHeader(subject)}`,
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
</head>
<body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#20242c;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">Your CartIQ verification code is inside. It expires in 10 minutes.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f5f7;">
    <tr>
      <td align="center" style="padding:36px 14px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background-color:#ffffff;border:1px solid #e7e9ee;border-radius:16px;overflow:hidden;">
          <tr>
            <td style="height:5px;background-color:#e73631;font-size:0;line-height:0;">&nbsp;</td>
          </tr>
          <tr>
            <td style="padding:26px 32px 22px;border-bottom:1px solid #eef0f3;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td width="42" valign="middle">
                    <img src="https://cartiq-8e46f.web.app/logo.png" alt="" width="36" height="36" style="display:block;width:36px;height:36px;border-radius:9px;" />
                  </td>
                  <td valign="middle" style="padding-left:10px;">
                    <p style="margin:0;color:#20242c;font-size:19px;font-weight:800;letter-spacing:-0.4px;line-height:1.2;">Cart<span style="color:#e73631;">IQ</span></p>
                    <p style="margin:3px 0 0;color:#777f8c;font-size:11px;line-height:1.3;">Pota Fries Operations</p>
                  </td>
                  <td align="right" valign="middle">
                    <span style="display:inline-block;padding:6px 9px;border-radius:99px;background-color:#fff1f0;color:#c62828;font-size:10px;font-weight:700;letter-spacing:0.6px;">ACCOUNT SECURITY</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 32px 28px;">
              <h1 style="margin:0 0 10px;color:#20242c;font-size:23px;font-weight:750;line-height:1.25;">${title}</h1>
              <p style="margin:0;color:#626b78;font-size:15px;line-height:1.6;">${subtitle}</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:26px;background-color:#fff8f7;border:1px solid #f5d4d1;border-radius:12px;">
                <tr>
                  <td align="center" style="padding:20px 16px 18px;">
                    <p style="margin:0 0 9px;color:#777f8c;font-size:11px;font-weight:700;letter-spacing:1px;">YOUR VERIFICATION CODE</p>
                    <p style="margin:0;color:#d8342e;font-family:'Courier New',Courier,monospace;font-size:36px;font-weight:800;letter-spacing:8px;line-height:1.25;">${code}</p>
                    <p style="margin:10px 0 0;color:#626b78;font-size:12px;line-height:1.4;">Expires in <strong style="color:#303641;">10 minutes</strong> &nbsp;&middot;&nbsp; One-time use</p>
                  </td>
                </tr>
              </table>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:22px;background-color:#f7f8fa;border-radius:10px;">
                <tr>
                  <td width="34" valign="top" style="padding:15px 0 15px 15px;color:#d8342e;font-size:16px;line-height:1.4;">&#9432;</td>
                  <td style="padding:15px 15px 15px 8px;color:#626b78;font-size:13px;line-height:1.55;">${securityMsg}</td>
                </tr>
              </table>
              <p style="margin:22px 0 0;color:#777f8c;font-size:12px;line-height:1.5;">For your security, never share this code with anyone. CartIQ staff will never ask you for it.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:17px 24px;background-color:#fafbfc;border-top:1px solid #eef0f3;text-align:center;">
              <p style="margin:0;color:#858d99;font-size:11px;line-height:1.5;">This is an automated security email from CartIQ.</p>
              <p style="margin:4px 0 0;color:#a0a6af;font-size:10px;line-height:1.4;">&copy; CartIQ &mdash; Pota Fries Operations</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
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

/** Subject + body for a recovery-email ownership check. */
export function verifyEmailContent(code) {
  return {
    subject: "Verify your email - CartIQ",
    text:
      `Your CartIQ email verification code is:\n\n${code}\n\n` +
      `It expires in 10 minutes and can only be used once.\n` +
      `If you didn't ask to verify this email, no account change was made.\n\n` +
      `- CartIQ (Pota Fries Operations)`,
    html: otpEmailHtml(
      code,
      "Verify your email",
      "Use this code to confirm this inbox belongs to your CartIQ account. It expires in 10 minutes and can only be used once.",
      "🔒 If you didn't request this code, ignore this email. No account changes were made.",
    ),
  };
}

export function otpEmailContent(code, purpose = OTP_PURPOSE_RESET) {
  if (purpose === OTP_PURPOSE_CHANGE) return changeEmailContent(code);
  if (purpose === OTP_PURPOSE_VERIFY) return verifyEmailContent(code);
  return resetEmailContent(code);
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
