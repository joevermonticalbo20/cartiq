// The resend guard: one place that decides whether another code may go out.
//
// The whole anti-spam story lives here:
//
//   * a 60 second cooldown between successful sends for one address
//   * at most 5 successful sends per address in 15 minutes
//   * a 15 minute lockout once that cap is reached
//   * a system-wide cap, so a spray across many addresses cannot turn the
//     service into a mail cannon
//
// The claim has to be ATOMIC. Two tabs, a refresh loop, or a direct API call
// arrive at the same time; if each of them read "no recent send" before any
// of them wrote, the cooldown would be useless. So the counters are read and
// written inside one Firestore transaction: a concurrent request either waits
// for it or is aborted and retried, never slips through.
//
// The slot is RESERVED before the email is sent (so a parallel request is
// turned away) and released again if the delivery failed (a mail that never
// arrived must not burn the address' budget).

import {
  OTP_GLOBAL_MAX_SENDS_PER_HOUR,
  evaluateGlobalPolicy,
  evaluateSendPolicy,
  hashOtp,
  normalizeEmail,
  otpLimitId,
} from "./password_reset.js";
import { captchaConfigured } from "./otp_anti_spam.js";

/** The document that holds the system-wide counter. */
export const OTP_GLOBAL_LIMIT_ID = "global";

/**
 * Claim the right to send one code to [email].
 *
 * Returns { allowed: true } when the send may go out, or
 * { allowed: false, reason, retryAfterMs, lockedUntil } when it may not.
 * The reason is one of "cooldown", "locked" or "global_limit".
 *
 * `suspicious` is true when this address has been pushing the guard: the
 * caller then wants a CAPTCHA before anything else goes out.
 */
export async function claimOtpSend({
  db,
  email,
  now = Date.now(),
  maxGlobal = OTP_GLOBAL_MAX_SENDS_PER_HOUR,
} = {}) {
  const id = otpLimitId(email);
  const cleanEmail = normalizeEmail(email);
  return db.runTransaction(async (tx) => {
    // Every read before every write: a Firestore transaction requires it.
    const [doc, globalDoc] = await Promise.all([
      tx.getDoc("otpRateLimits", id),
      tx.getDoc("otpRateLimits", OTP_GLOBAL_LIMIT_ID),
    ]);
    const current = doc ?? {};
    const suspicious = Number(current.suspiciousUntil ?? 0) > now;
    const verdict = evaluateSendPolicy(current, now);
    if (!verdict.allowed) {
      if (verdict.reason === "locked" && verdict.lockedUntil) {
        // Remember the lockout so the state is explicit (and survives a
        // restart of the request path), and mark the address suspicious:
        // something is pushing it, so the next request wants a CAPTCHA.
        await tx.setDoc("otpRateLimits", id, {
          ...current,
          email: cleanEmail,
          lockedUntil: new Date(verdict.lockedUntil),
          suspiciousUntil: new Date(verdict.lockedUntil),
          updatedAt: new Date(now),
        });
      }
      return { allowed: false, suspicious, ...verdict };
    }
    const globalVerdict = evaluateGlobalPolicy(globalDoc ?? {}, now, maxGlobal);
    if (!globalVerdict.allowed) {
      return { allowed: false, suspicious, ...globalVerdict, reason: "global_limit" };
    }
    await tx.setDoc("otpRateLimits", id, {
      email: cleanEmail,
      windowStartedAt: new Date(verdict.windowStartedAt),
      sends: verdict.sends + 1,
      lastSentAt: new Date(now),
      lockedUntil: null,
      updatedAt: new Date(now),
    });
    await tx.setDoc("otpRateLimits", OTP_GLOBAL_LIMIT_ID, {
      windowStartedAt: new Date(globalVerdict.windowStartedAt),
      sends: globalVerdict.sends + 1,
      updatedAt: new Date(now),
    });
    return { allowed: true, suspicious, sends: verdict.sends + 1 };
  });
}

/**
 * Whether this request must carry a CAPTCHA.
 *
 * Only when one is configured (so nothing changes until the owner turns it
 * on) and the request did not come from the app: the app proves itself with
 * Firebase App Check instead.
 */
export function captchaRequiredFor({ req, suspicious }) {
  if (!suspicious) return false;
  if (!captchaConfigured()) return false;
  const client = String(req?.headers?.["x-client"] ?? "").toLowerCase();
  if (client.includes("cartiq-android") || client.includes("cartiq-ios")) {
    return false;
  }
  return true;
}

/**
 * Give a reserved slot back after a failed delivery.
 *
 * The address still keeps its cooldown (a failed send is still an attempt),
 * but the budget is not spent on a mail nobody received.
 */
export async function releaseOtpSend({ db, email, now = Date.now() } = {}) {
  const id = otpLimitId(email);
  try {
    await db.runTransaction(async (tx) => {
      const doc = await tx.getDoc("otpRateLimits", id);
      if (!doc) return;
      const sends = Math.max(0, (Number(doc.sends ?? 0) || 0) - 1);
      await tx.setDoc("otpRateLimits", id, {
        ...doc,
        sends,
        updatedAt: new Date(now),
      });
    });
  } catch {
    // A failed release only costs one send of budget - never fail the flow.
  }
}

/**
 * Log a request the guard turned away.
 *
 * Never the code, never a password, never the address in clear: the hash is
 * enough to spot a pattern across requests.
 */
export function logOtpSuspicion({ reason, email, ip, userId, extra } = {}) {
  const who = email ? hashOtp(normalizeEmail(email)).slice(0, 12) : "-";
  console.warn(
    `[otp:guard] blocked=${reason} address=${who} ip=${ip ?? "-"} user=${userId ?? "-"}${
      extra ? ` ${extra}` : ""
    }`,
  );
}
