/**
 * reCAPTCHA v3, loaded on demand.
 *
 * Google changed the script URL to `api.js?render=KEY`. There is nothing to
 * install: the script is injected the first time a code is actually needed,
 * so pages that never send an OTP pay nothing.
 *
 * Used only when VITE_RECAPTCHA_SITE_KEY is configured and the server asks
 * for it (the resend guard flagged the traffic as suspicious). The token
 * goes to the server as `captchaToken`; Google decides the score; the server
 * decides whether to allow the send.
 */

let scriptPromise = null;

export function recaptchaEnabled() {
  return Boolean(import.meta.env.VITE_RECAPTCHA_SITE_KEY);
}

function loadScript() {
  const key = import.meta.env.VITE_RECAPTCHA_SITE_KEY;
  if (!key) return Promise.reject(new Error("reCAPTCHA is not configured"));
  if (window.grecaptcha?.ready) return Promise.resolve(window.grecaptcha);
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(key)}`;
      script.async = true;
      script.defer = true;
      script.onload = () => resolve(window.grecaptcha);
      script.onerror = () => {
        scriptPromise = null;
        reject(new Error("Could not load the verification challenge."));
      };
      document.head.appendChild(script);
    });
  }
  return scriptPromise;
}

/**
 * Ask Google for a token for [action] ("otp_request" is the only one in use).
 * Returns null when reCAPTCHA is not configured or the script could not load -
 * the server decides what a missing token means.
 */
export async function executeRecaptcha(action = "otp_request") {
  if (!recaptchaEnabled()) return null;
  const grecaptcha = await loadScript();
  return new Promise((resolve) => {
    grecaptcha.ready(() => {
      grecaptcha.execute(import.meta.env.VITE_RECAPTCHA_SITE_KEY, { action }).then(
        (token) => resolve(token),
        () => resolve(null),
      );
    });
  });
}
