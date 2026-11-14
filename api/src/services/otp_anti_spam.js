// Anti-spam extras for the OTP mails.
//
// Two independent layers, both OPT-IN, so the existing registration / login /
// OTP flows keep working exactly as they do today:
//
//   1. Firebase App Check - the request carries a token proving it came from
//      the real app (Play Integrity on Android, reCAPTCHA v3 on the web).
//      Enforced only when APP_CHECK_ENFORCE=true; otherwise a token that IS
//      present is still verified (and a bad one is logged).
//   2. A CAPTCHA for suspicious traffic - when the resend guard has turned
//      requests away for an address, the next request from it must carry a
//      CAPTCHA token. Required only when RECAPTCHA_SECRET is configured.
//
// Nothing here ever sees an OTP code or a credential: the App Check token and
// the CAPTCHA token are one-use proofs, not secrets of the account.

import { createHash } from "node:crypto";

/** True when App Check must be present AND valid on the request. */
export function appCheckEnforced() {
  return String(process.env.APP_CHECK_ENFORCE ?? "").toLowerCase() === "true";
}

/** True when a CAPTCHA is configured (and therefore can be demanded). */
export function captchaConfigured() {
  return Boolean(String(process.env.RECAPTCHA_SECRET ?? "").trim());
}

/**
 * Verify a Firebase App Check token.
 *
 * The Admin SDK is already initialised for Firestore, so the same service
 * account verifies the token: it proves the request came from the real app
 * (Play Integrity on Android, reCAPTCHA v3 on the web).
 *
 * Returns { ok } - never throws, never leaks the token.
 */
export async function verifyAppCheckToken(token) {
  const value = String(token ?? "").trim();
  if (!value) return { ok: false, reason: "missing" };
  try {
    const { getApps } = await import("firebase-admin/app");
    const { getAppCheck } = await import("firebase-admin/app-check");
    const app = getApps()[0];
    if (!app) return { ok: false, reason: "no_credentials" };
    const check = await getAppCheck(app).verifyToken(value);
    return { ok: true, appId: check?.appId ?? null };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

/**
 * Verify a reCAPTCHA v3 token (score based).
 *
 * The score is what matters: 0.0 (very likely a bot) .. 1.0 (very likely a
 * human). Anything below RECAPTCHA_MIN_SCORE (default 0.5) is a bot.
 */
export async function verifyCaptchaToken(token, { ip } = {}) {
  const secret = String(process.env.RECAPTCHA_SECRET ?? "").trim();
  if (!secret) return { ok: false, reason: "not_configured" };
  const value = String(token ?? "").trim();
  if (!value) return { ok: false, reason: "missing" };
  const minScore = Number(process.env.RECAPTCHA_MIN_SCORE ?? 0.5);
  try {
    const body = new URLSearchParams({ secret, response: value });
    if (ip) body.set("remoteip", String(ip));
    const res = await fetch("https://www.google.com/recaptcha/api/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const out = await res.json().catch(() => null);
    const score = Number(out?.score ?? 0);
    const ok = out?.success === true && score >= minScore;
    return { ok, score, reason: out?.success === true ? "" : "rejected" };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}

/**
 * The App Check token on a request, if the client sent one.
 */
export function appCheckTokenFrom(req) {
  const headers = req?.headers ?? {};
  const raw = headers["x-firebase-appcheck"] ?? headers["X-Firebase-AppCheck"];
  return Array.isArray(raw) ? raw[0] : raw ?? null;
}

/**
 * The CAPTCHA token on a request, if the client sent one.
 */
export function captchaTokenFrom(req) {
  const body = req?.body ?? {};
  return body.captchaToken ?? body.recaptchaToken ?? null;
}

/**
 * A short, non-reversible id for an address, for logs.
 */
export function fingerprint(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 12);
}
