import { createRequire } from "node:module";
import { db as prisma } from "../firestore.js";

const require = createRequire(import.meta.url);
const { getMessaging } = require("firebase-admin/messaging");

const PUSH_TYPES = new Set(["VOID_DECISION", "RESTOCK_UPDATE", "LOW_STOCK_NOTIFY"]);
// The signal the server sends when the MENU changed (product archived, price
// or recipe edited, stock adjusted). The app reloads its catalog silently -
// no notification, because a visible popup for every menu tweak trains the
// vendor to dismiss them.
export const CATALOG_PUSH_TYPE = "CATALOG_CHANGED";
// Mobile displays these through the `cartiq_alerts` channel in both paths:
// native display in the background, and app-owned local notification in the
// foreground. Android collapses messages with the same collapse key/tag into
// one visible notification per alert.
const CHANNEL_ID = "cartiq_alerts";

function cleanToken(token) {
  const value = String(token ?? "").trim();
  if (!value || value.length > 4096) return null;
  return value;
}

function cleanUserId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function pushTitle(alert) {
  const title = String(alert?.title ?? "").trim();
  if (title) return title.slice(0, 200);
  if (alert?.type === "VOID_DECISION") return "Void request update";
  if (alert?.type === "LOW_STOCK_NOTIFY") return "Low stock";
  return "Restock request update";
}

function pushBody(alert) {
  return String(alert?.message ?? "").trim().slice(0, 1000);
}

function alertType(alert) {
  return String(alert?.type ?? "").toUpperCase();
}

async function pruneTokens(tokens, db = prisma) {
  if (!tokens.length) return;
  try {
    await db.pushTokens.deleteMany({ where: { token: { in: tokens } } });
  } catch {
    // Cleanup is best-effort; a stale token will fail again next time.
  }
}

/**
 * Send a best-effort high-priority FCM notification to every registered
 * mobile token for the targeted alert's user.
 *
 * Scope is intentionally narrow: only alerts created for a specific staff
 * user (void decisions and restock-status updates) are pushed. Owner-feed
 * alerts (void requests, new restock requests) never reach a phone.
 * Never throws: push must not fail the void/restock mutation.
 */
export async function sendTargetedPush(alert, { db = prisma, messaging = undefined } = {}) {
  try {
    if (!alert || alert.userId == null) return;
    const type = alertType(alert);
    if (!PUSH_TYPES.has(type)) return;
    const userId = cleanUserId(alert.userId);
    if (!userId) return;

    const rows = await db.pushTokens.findMany({ where: { userId } });
    const tokens = rows
      .map((row) => cleanToken(row?.token))
      .filter(Boolean);
    if (!tokens.length) return;

    const title = pushTitle(alert);
    const body = pushBody(alert);
    const alertTag = alert.id == null ? null : String(alert.id);
    const message = {
      tokens,
      notification: { title, body },
      data: {
        alertId: alertTag ?? "",
        type,
        title,
        body,
      },
      android: {
        priority: "high",
        collapseKey: alertTag ?? "",
        notification: {
          channelId: CHANNEL_ID,
          tag: alertTag,
          visibility: "public",
          clickAction: "FLUTTER_NOTIFICATION_CLICK",
        },
      },
    };

    let result;
    try {
      result = await (messaging ?? getMessaging()).sendEachForMulticast(message);
    } catch {
      // Messaging is unavailable (no credentials, local dev): the alert
      // remains in the inbox and the 3-second poll still sees it.
      return;
    }

    const invalid = [];
    (result?.responses ?? []).forEach((response, index) => {
      const code = String(response?.error?.code ?? "");
      if (
        !response?.success &&
        (/not-found|unregistered|invalid-argument|invalid-token|registration-token-not-registered/i.test(code))
      ) {
        invalid.push(tokens[index]);
      }
    });
    await pruneTokens(invalid, db);
  } catch {
    // Never let push delivery affect the API mutation.
  }
}

export const __pushTestHelpers = {
  cleanToken,
  cleanUserId,
  pushTitle,
  pushBody,
  alertType,
};

/**
 * Tell every registered device about a shift that was just recorded.
 *
 * The vendor taps a card on the reader and the app must show it right away -
 * the tap is the whole point of the reader. The POS app refreshes on this
 * push (a DATA-ONLY message: no notification to dismiss), and the web
 * dashboard gets the same thing over its SSE stream.
 */
export async function sendShiftPush(
  { event, staffUid, staffName, locationCode } = {},
  { db = prisma, messaging = undefined } = {},
) {
  try {
    const rows = await db.pushTokens.findMany({});
    const tokens = rows.map((row) => cleanToken(row?.token)).filter(Boolean);
    if (!tokens.length) return;

    const data = {
      type: "SHIFT",
      event: String(event ?? "").toUpperCase(),
      staffUid: String(staffUid ?? ""),
      staffName: String(staffName ?? ""),
      locationCode: String(locationCode ?? ""),
    };
    const message = {
      tokens,
      data,
      android: {
        priority: "high",
        // One pending refresh is enough: the newest state wins.
        collapseKey: "shift",
      },
    };

    let result;
    try {
      result = await (messaging ?? getMessaging()).sendEachForMulticast(message);
    } catch {
      // Messaging is unavailable (no credentials, local dev): the app still
      // picks the tap up on its next poll.
      return;
    }

    const invalid = [];
    (result?.responses ?? []).forEach((response, index) => {
      const code = String(response?.error?.code ?? "");
      if (
        !response?.success &&
        (/not-found|unregistered|invalid-argument|invalid-token|registration-token-not-registered/i.test(code))
      ) {
        invalid.push(tokens[index]);
      }
    });
    await pruneTokens(invalid, db);
  } catch {
    // Never let push delivery affect the tap that caused it.
  }
}

/**
 * Tell every registered POS device that the menu moved.
 *
 * The phones poll the catalog version every 30s, which is fine for "is
 * anything new?" but too slow for "the owner just archived a product and
 * the vendor must stop selling it". This is the push that closes that gap:
 * a high-priority DATA-ONLY message, so Android stays silent and the app
 * simply reloads its menu.
 *
 * Every device gets it (the catalog is global), not one user. Never throws:
 * a failed push must not fail the mutation that caused it - the 30s version
 * poll is the fallback.
 */
export async function sendCatalogPush(
  { scope = "catalog", name = null, version = null } = {},
  { db = prisma, messaging = undefined } = {},
) {
  try {
    const rows = await db.pushTokens.findMany({});
    const tokens = rows.map((row) => cleanToken(row?.token)).filter(Boolean);
    if (!tokens.length) return;

    const message = {
      tokens,
      // Data only: no notification block, so nothing pops up on the device.
      data: {
        type: CATALOG_PUSH_TYPE,
        scope: String(scope ?? "catalog").slice(0, 40),
        name: name ? String(name).slice(0, 120) : "",
        version: version == null ? "" : String(version),
      },
      android: {
        priority: "high",
        // One pending menu refresh is enough: the newest state wins.
        collapseKey: "catalog",
      },
    };

    let result;
    try {
      result = await (messaging ?? getMessaging()).sendEachForMulticast(message);
    } catch {
      // Messaging is unavailable (no credentials, local dev): the phone's
      // 30-second version poll still picks the change up.
      return;
    }

    const invalid = [];
    (result?.responses ?? []).forEach((response, index) => {
      const code = String(response?.error?.code ?? "");
      if (
        !response?.success &&
        (/not-found|unregistered|invalid-argument|invalid-token|registration-token-not-registered/i.test(code))
      ) {
        invalid.push(tokens[index]);
      }
    });
    await pruneTokens(invalid, db);
  } catch {
    // Never let push delivery affect the API mutation.
  }
}
