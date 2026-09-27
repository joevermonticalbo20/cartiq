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
//      The refresh token never expires unless revoked in the Google account.
//
// Env: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_FROM.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

let _cached = null; // { token, expMs }

function gmailEnv() {
  const get = (k) =>
    typeof process !== "undefined" && process.env ? process.env[k] ?? "" : "";
  // Deno/Edge reads Deno.env instead (see the mirrored sender in index.ts).
  try {
    if (typeof Deno !== "undefined" && Deno.env) {
      return {
        clientId: Deno.env.get("GMAIL_CLIENT_ID") ?? "",
        clientSecret: Deno.env.get("GMAIL_CLIENT_SECRET") ?? "",
        refreshToken: Deno.env.get("GMAIL_REFRESH_TOKEN") ?? "",
        from: Deno.env.get("GMAIL_FROM") ?? "",
      };
    }
  } catch {
    // Deno.env denied -> fall through to process.env (unit tests).
  }
  return {
    clientId: get("GMAIL_CLIENT_ID"),
    clientSecret: get("GMAIL_CLIENT_SECRET"),
    refreshToken: get("GMAIL_REFRESH_TOKEN"),
    from: get("GMAIL_FROM"),
  };
}

export function gmailConfigured() {
  const { clientId, clientSecret, refreshToken, from } = gmailEnv();
  return Boolean(clientId && clientSecret && refreshToken && from);
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
 * Send a plain-text email from the configured Gmail account.
 * Throws on misconfiguration or API failure — callers (forgot-password)
 * catch, log server-side, and still return the generic success response.
 */
export async function sendGmail({ to, subject, text }) {
  const { from } = gmailEnv();
  if (!from) throw new Error("Gmail is not configured (missing GMAIL_FROM)");
  const token = await getAccessToken();
  const raw = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    "",
    text,
  ].join("\r\n");
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

/** Subject + body for a password-reset OTP. Kept here so both runtimes agree. */
export function resetEmailContent(code) {
  return {
    subject: "CartIQ password reset code",
    text:
      `Your CartIQ password reset code is:\n\n${code}\n\n` +
      `It expires in 10 minutes and can only be used once.\n` +
      `If you didn't ask for this, you can ignore this email.\n\n` +
      `— CartIQ (Pota Fries Operations)`,
  };
}
