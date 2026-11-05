import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeEmail,
  validEmail,
  generateOtp,
  hashOtp,
  otpMatches,
  otpPurpose,
  placeholderEmailFor,
  isPlaceholderEmail,
  maskEmail,
  OTP_LENGTH,
  OTP_TTL_MS,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_MS,
  OTP_PURPOSE_RESET,
  OTP_PURPOSE_CHANGE,
  FORGOT_GENERIC_MESSAGE,
  RESET_INVALID_MESSAGE,
  CHANGE_INVALID_MESSAGE,
  APP_UPDATE_REQUIRED_MESSAGE,
  RECOVERY_EMAIL_REQUIRED_MESSAGE,
} from "../src/services/password_reset.js";
import {
  gmailConfigured,
  sendGmail,
  resetEmailContent,
  changeEmailContent,
  otpEmailContent,
  sendOtpEmail,
  emailProvider,
  emailProviderAllowed,
  emailStatus,
  gmailStatus,
  _resetGmailCacheForTests,
} from "../src/services/gmail.js";

describe("normalizeEmail / validEmail", () => {
  it("trims and lowercases", () => {
    assert.equal(normalizeEmail("  Staff@Example.COM "), "staff@example.com");
    assert.equal(normalizeEmail(null), "");
  });

  it("accepts normal addresses, rejects garbage", () => {
    assert.equal(validEmail("staff01@gmail.com"), true);
    assert.equal(validEmail("a@b.co"), true);
    assert.equal(validEmail("not-an-email"), false);
    assert.equal(validEmail("a@b"), false);
    assert.equal(validEmail(""), false);
    assert.equal(validEmail(null), false);
    assert.equal(validEmail("x".repeat(250) + "@ex.com"), false);
  });
});

describe("generateOtp / hashOtp / otpMatches", () => {
  it("generates zero-padded 6-digit codes", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateOtp();
      assert.match(code, /^\d{6}$/);
      assert.equal(code.length, OTP_LENGTH);
    }
  });

  it("hash is deterministic hex, never the code itself", () => {
    const h = hashOtp("123456");
    assert.equal(h, hashOtp("123456"));
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.ok(!h.includes("123456"));
  });

  it("matches the right code, rejects neighbours", () => {
    const h = hashOtp("482916");
    assert.equal(otpMatches("482916", h), true);
    assert.equal(otpMatches("482915", h), false);
    assert.equal(otpMatches("", h), false);
    assert.equal(otpMatches("482916", "not-hex"), false);
    assert.equal(otpMatches("482916", null), false);
  });
});

describe("policy constants", () => {
  it("short TTL, capped attempts, silent cooldown", () => {
    assert.equal(OTP_TTL_MS, 10 * 60 * 1000);
    assert.equal(OTP_MAX_ATTEMPTS, 5);
    assert.equal(OTP_RESEND_COOLDOWN_MS, 60 * 1000);
  });

  it("generic messages reveal nothing", () => {
    assert.ok(!FORGOT_GENERIC_MESSAGE.includes("@"));
    assert.ok(!/email|account|exist|sent to/i.test(RESET_INVALID_MESSAGE));
    assert.equal(CHANGE_INVALID_MESSAGE, RESET_INVALID_MESSAGE);
  });

  it("old apps get a clear update hint, not a code oracle", () => {
    assert.match(APP_UPDATE_REQUIRED_MESSAGE, /6-digit code/i);
    assert.match(APP_UPDATE_REQUIRED_MESSAGE, /update to the latest version/i);
    assert.match(RECOVERY_EMAIL_REQUIRED_MESSAGE, /recovery email/i);
  });
});

describe("OTP purpose + recovery-email helpers", () => {
  it("legacy records are resets; only an explicit change is a change", () => {
    assert.equal(otpPurpose(undefined), OTP_PURPOSE_RESET);
    assert.equal(otpPurpose({}), OTP_PURPOSE_RESET);
    assert.equal(otpPurpose({ purpose: "anything-else" }), OTP_PURPOSE_RESET);
    assert.equal(otpPurpose({ purpose: OTP_PURPOSE_CHANGE }), OTP_PURPOSE_CHANGE);
    assert.equal(otpPurpose({ purpose: OTP_PURPOSE_RESET }), OTP_PURPOSE_RESET);
  });

  it("builds visible but non-deliverable placeholders", () => {
    assert.equal(placeholderEmailFor("Staff 01!"), "staff01@cartiq.local");
    assert.equal(placeholderEmailFor(""), "staff@cartiq.local");
    assert.equal(isPlaceholderEmail("OWNER@CARTIQ.LOCAL"), true);
    assert.equal(isPlaceholderEmail("owner@example.com"), false);
    assert.equal(isPlaceholderEmail(null), false);
  });

  it("masks the address without revealing the local part", () => {
    assert.equal(maskEmail("staff@gmail.com"), "st***@gmail.com");
    assert.equal(maskEmail("  A@B.CO "), "a***@b.co");
    assert.equal(maskEmail("not-an-email"), "");
    assert.equal(maskEmail(""), "");
  });
});

describe("OTP email content", () => {
  it("a reset code says reset, a change code says change", () => {
    const reset = resetEmailContent("482916");
    const change = changeEmailContent("482916");
    const viaPurpose = otpEmailContent("482916", OTP_PURPOSE_CHANGE);
    assert.match(reset.subject, /reset/i);
    assert.match(reset.text, /482916/);
    assert.match(reset.text, /10 minutes/i);
    assert.match(change.subject, /change/i);
    assert.match(change.text, /482916/);
    assert.match(change.text, /NOT changed/i);
    assert.match(change.html, /ACCOUNT SECURITY/);
    assert.match(change.html, /YOUR VERIFICATION CODE/);
    assert.match(change.html, />482916</);
    assert.match(change.html, /CartIQ staff will never ask you for it/);
    assert.deepEqual(viaPurpose, change);
    assert.deepEqual(otpEmailContent("482916"), reset);
  });
});

function withEnv(changes, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(changes)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

describe("email provider selection", () => {
  const gmail = {
    GMAIL_CLIENT_ID: "cid",
    GMAIL_CLIENT_SECRET: "csec",
    GMAIL_REFRESH_TOKEN: "rtok",
    GMAIL_FROM: "cartiq@example.com",
  };

  it("uses explicit EMAIL_PROVIDER, else Gmail when configured, else console", async () => {
    await withEnv({ ...gmail, EMAIL_PROVIDER: undefined }, () => {
      assert.equal(emailProvider(), "gmail");
    });
    await withEnv({ ...gmail, EMAIL_PROVIDER: "console" }, () => {
      assert.equal(emailProvider(), "console");
    });
    await withEnv(
      {
        EMAIL_PROVIDER: undefined,
        GMAIL_CLIENT_ID: undefined,
        GMAIL_CLIENT_SECRET: undefined,
        GMAIL_REFRESH_TOKEN: undefined,
        GMAIL_FROM: undefined,
      },
      () => {
        assert.equal(emailProvider(), "console");
      },
    );
  });

  it("console is allowed locally, never in production; unknown providers are never allowed", async () => {
    await withEnv({ NODE_ENV: "production" }, () => {
      assert.equal(emailProviderAllowed("console"), false);
      assert.equal(emailProviderAllowed("gmail"), true);
      assert.equal(emailProviderAllowed("sendgrid"), false);
    });
    await withEnv({ NODE_ENV: "development" }, () => {
      assert.equal(emailProviderAllowed("console"), true);
    });
  });

  it("console mode logs the code instead of sending", async () => {
    await withEnv({ EMAIL_PROVIDER: "console", NODE_ENV: "development" }, async () => {
      const original = console.log;
      const lines = [];
      console.log = (...args) => lines.push(args.join(" "));
      try {
        const result = await sendOtpEmail({
          to: "owner@cartiq.local",
          code: "482916",
          purpose: OTP_PURPOSE_CHANGE,
        });
        assert.deepEqual(result, { provider: "console", sent: false, logged: true });
        assert.ok(lines.join("\n").includes("482916"));
        assert.ok(lines.join("\n").includes("password change code"));
      } finally {
        console.log = original;
      }
    });
  });

  it("gmail skips a placeholder without calling the API", async () => {
    await withEnv({ ...gmail, EMAIL_PROVIDER: "gmail" }, async () => {
      let called = false;
      const realFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        called = true;
        throw new Error("must not be called");
      };
      try {
        const result = await sendOtpEmail({
          to: "staff01@cartiq.local",
          code: "482916",
        });
        assert.deepEqual(result, { provider: "gmail", sent: false, placeholder: true });
        assert.equal(called, false);
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  });

  it("console in production is rejected before logging anything", async () => {
    await withEnv({ EMAIL_PROVIDER: "console", NODE_ENV: "production" }, async () => {
      await assert.rejects(
        sendOtpEmail({ to: "staff@example.com", code: "482916" }),
        /disabled in production/,
      );
    });
  });

  it("emailStatus exposes provider and allowed without secrets", async () => {
    await withEnv({ ...gmail, EMAIL_PROVIDER: "gmail" }, async () => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ access_token: "ya29.mock", expires_in: 3600 }), {
          headers: { "content-type": "application/json" },
        });
      try {
        const s = await emailStatus();
        assert.equal(s.provider, "gmail");
        assert.equal(s.allowed, true);
        assert.equal(s.configured, true);
        const body = JSON.stringify(s);
        assert.ok(!body.includes("csec"));
        assert.ok(!body.includes("rtok"));
        assert.ok(!body.includes("ya29.mock"));
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  });

  it("reports a sender-less Gmail setup as not configured", async () => {
    await withEnv({ ...gmail, GMAIL_FROM: undefined, EMAIL_PROVIDER: "gmail" }, async () => {
      const s = await emailStatus();
      assert.equal(s.configured, false);
      assert.equal(s.present.from, false);
      assert.equal(s.exchange, "skipped");
      assert.match(s.error, /GMAIL_FROM/);
    });
  });
});

describe("gmail sender (stubbed fetch)", () => {
  const calls = [];
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    calls.length = 0;
    _resetGmailCacheForTests();
    process.env.GMAIL_CLIENT_ID = "cid";
    process.env.GMAIL_CLIENT_SECRET = "csec";
    process.env.GMAIL_REFRESH_TOKEN = "rtok";
    process.env.GMAIL_FROM = "cartiq@example.com";
    globalThis.fetch = async (url, opts = {}) => {
      calls.push({ url: String(url), opts });
      if (String(url).includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "ya29.mock", expires_in: 3600 }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (String(url).includes("gmail.googleapis.com")) {
        return new Response(JSON.stringify({ id: "msg1" }), {
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error("UNMOCKED: " + url);
    };
  });

  it("exchanges the refresh token once, then sends RFC2822 base64url", async () => {
    assert.equal(gmailConfigured(), true);
    await sendGmail({ to: "staff@gmail.com", subject: "S", text: "hello" });
    // Second send reuses the cached access token (no second exchange).
    await sendGmail({ to: "staff@gmail.com", subject: "S", text: "hello again" });
    const exchanges = calls.filter((c) => c.url.includes("oauth2"));
    const sends = calls.filter((c) => c.url.includes("gmail.googleapis"));
    assert.equal(exchanges.length, 1);
    assert.equal(sends.length, 2);
    const body = JSON.parse(sends[0].opts.body);
    assert.ok(body.raw && !body.raw.includes("+") && !body.raw.includes("/"));
    assert.equal(sends[0].opts.headers.Authorization, "Bearer ya29.mock");
    globalThis.fetch = realFetch;
  });

  it("throws a clear error when unconfigured", async () => {
    delete process.env.GMAIL_CLIENT_ID;
    _resetGmailCacheForTests();
    await assert.rejects(sendGmail({ to: "a@b.co", subject: "s", text: "t" }), /not configured/);
    globalThis.fetch = realFetch;
  });

  it("reset email content carries the code and expiry", () => {
    const { subject, text } = resetEmailContent("482916");
    assert.ok(subject.length > 0);
    assert.ok(text.includes("482916"));
    assert.ok(/10 minute/i.test(text));
  });
});

describe("gmailStatus (diagnostics, no secret values)", () => {
  const calls = [];
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    calls.length = 0;
    _resetGmailCacheForTests();
    process.env.GMAIL_CLIENT_ID = "cid";
    process.env.GMAIL_CLIENT_SECRET = "csec";
    process.env.GMAIL_REFRESH_TOKEN = "rtok";
    process.env.GMAIL_FROM = "cartiq@example.com";
    globalThis.fetch = async (url, opts = {}) => {
      calls.push(String(url));
      if (String(url).includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "ya29.mock", expires_in: 3600 }), {
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error("UNMOCKED: " + url);
    };
  });

  it("reports skipped when secrets are missing", async () => {
    delete process.env.GMAIL_CLIENT_ID;
    const s = await gmailStatus();
    assert.equal(s.configured, false);
    assert.equal(s.exchange, "skipped");
    assert.equal(s.present.clientId, false);
    globalThis.fetch = realFetch;
  });

  it("reports ok on working exchange, failed otherwise - never leaking values", async () => {
    const ok = await gmailStatus();
    assert.equal(ok.configured, true);
    assert.equal(ok.exchange, "ok");
    assert.ok(!JSON.stringify(ok).includes("csec"));

    _resetGmailCacheForTests();
    globalThis.fetch = async (url) => {
      if (String(url).includes("oauth2")) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error("UNMOCKED");
    };
    try {
      const bad = await gmailStatus();
      assert.equal(bad.configured, false);
      assert.equal(bad.exchange, "failed");
      assert.ok(bad.error.length > 0);
      assert.ok(!JSON.stringify(bad).includes("csec"));
      assert.ok(!JSON.stringify(bad).includes("rtok"));
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
