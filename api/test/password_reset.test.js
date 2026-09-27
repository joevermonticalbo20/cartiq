import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeEmail,
  validEmail,
  generateOtp,
  hashOtp,
  otpMatches,
  OTP_LENGTH,
  OTP_TTL_MS,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_MS,
  FORGOT_GENERIC_MESSAGE,
  RESET_INVALID_MESSAGE,
} from "../src/services/password_reset.js";
import {
  gmailConfigured,
  sendGmail,
  resetEmailContent,
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
