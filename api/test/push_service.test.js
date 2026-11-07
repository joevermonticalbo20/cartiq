import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { sendTargetedPush, __pushTestHelpers } from "../src/services/push.js";

function fakeDb(rows, deleted = []) {
  return {
    pushTokens: {
      findMany: async () => rows,
      deleteMany: async (args) => {
        deleted.push(args);
        return { count: args.where.token.in.length };
      },
    },
  };
}

describe("push service (staff FCM)", () => {
  it("cleans and validates tokens and user ids", () => {
    assert.equal(__pushTestHelpers.cleanToken("  abc  "), "abc");
    assert.equal(__pushTestHelpers.cleanToken(""), null);
    assert.equal(__pushTestHelpers.cleanUserId("123"), 123);
    assert.equal(__pushTestHelpers.cleanUserId("0"), null);
  });

  it("uses alert title/body and falls back safely", () => {
    const alert = { type: "VOID_DECISION", title: "Void approved", message: "Order #1 voided." };
    assert.equal(__pushTestHelpers.pushTitle(alert), "Void approved");
    assert.equal(__pushTestHelpers.pushBody(alert), "Order #1 voided.");
    assert.equal(__pushTestHelpers.pushTitle({ type: "RESTOCK_UPDATE" }), "Restock request update");
    assert.equal(__pushTestHelpers.pushBody({ type: "RESTOCK_UPDATE", title: "Restocked", message: "" }), "");
  });

  it("sends a high-priority FCM payload only for targeted alert types", async () => {
    const sent = [];
    const messaging = {
      sendEachForMulticast: async (message) => {
        sent.push(message);
        return { successCount: message.tokens.length, failureCount: 0, responses: message.tokens.map(() => ({ success: true })) };
      },
    };
    await sendTargetedPush(
      { id: 42, type: "VOID_DECISION", userId: 7, title: "Void approved", message: "Order #123 voided." },
      { db: fakeDb([{ userId: 7, token: "token-a" }]), messaging },
    );
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].tokens, ["token-a"]);
    assert.equal(sent[0].collapseKey, "42");
    assert.equal(sent[0].notification.title, "Void approved");
    assert.equal(sent[0].notification.body, "Order #123 voided.");
    assert.equal(sent[0].data.alertId, "42");
    assert.equal(sent[0].data.type, "VOID_DECISION");
    assert.equal(sent[0].data.title, "Void approved");
    assert.equal(sent[0].data.body, "Order #123 voided.");
    assert.equal(sent[0].android.priority, "high");
    assert.equal(sent[0].android.notification.channelId, "cartiq_alerts");
    assert.equal(sent[0].android.notification.tag, "42");
    assert.equal(sent[0].android.notification.clickAction, "FLUTTER_NOTIFICATION_CLICK");
  });

  it("does not send for owner-feed alert types", async () => {
    let called = false;
    const messaging = { sendEachForMulticast: async () => { called = true; } };
    await sendTargetedPush(
      { id: 1, type: "VOID_REQUEST", userId: 9, title: "x", message: "y" },
      { db: fakeDb([{ userId: 9, token: "tok" }]), messaging },
    );
    assert.equal(called, false);
  });

  it("prunes tokens FCM reports as unregistered", async () => {
    const deleted = [];
    const messaging = {
      sendEachForMulticast: async () => ({
        successCount: 1,
        failureCount: 1,
        responses: [
          { success: false, error: { code: "messaging/unregistered" } },
          { success: true },
        ],
      }),
    };
    const db = fakeDb([{ userId: 3, token: "bad" }, { userId: 3, token: "good" }], deleted);
    await sendTargetedPush(
      { id: 5, type: "RESTOCK_UPDATE", userId: 3, title: "Restocked", message: "Done" },
      { db, messaging },
    );
    assert.deepEqual(deleted, [{ where: { token: { in: ["bad"] } } }]);
  });
});
