// Announce an owner change to every screen and every phone.
//
// The dashboard is one browser talking to one server, but the change is seen
// in many places: the other tab of the same browser, the owner's other
// browser, and the phone at the cart. Each of them used to learn about a
// change only by reloading (the web) or by waiting out a cache (the app).
//
// One announcement, three channels:
//
//   1. an SSE frame "<kind>:updated"  -> the web refetches the affected list
//   2. a data-only push "DATA_CHANGED" -> every phone refetches, silently
//   3. (the web) a BroadcastChannel      -> the other tabs of the same
//                                         browser refetch at once
//
// Best-effort by design: a missed announcement must never fail the mutation
// that caused it. The next poll or reload still picks the change up.
//
// The same helper lives in supabase/functions/api/index.ts (the production
// Edge path) - keep both in sync when changing policy.

import { sendDevicePush } from "./push.js";
import { emit } from "../routes/events.js";

/** The data-only push the phone reacts to. Silent: no notification popup. */
export const DATA_CHANGED_PUSH_TYPE = "DATA_CHANGED";

/**
 * What changed. The kind is the contract between the server and the clients:
 * the web refetches the list with that name, the phone refetches what that
 * kind means for it.
 */
export const CHANGE_KINDS = Object.freeze([
  "locations", // a cart was added, renamed, deactivated or reactivated
  "devices", // a reader was registered, reassigned, disabled or removed
  "staff", // a staff / admin account was added, edited or disabled
  "expenses", // an expense was added, edited or deleted
  "alerts", // an alert was read, acknowledged or resolved
]);

/**
 * The live frame name for one kind of change.
 *
 * The name is the contract with the web: the shared live store listens for
 * "<kind>:updated" and refetches the list it owns.
 */
export function changeEventName(kind) {
  return `${String(kind ?? "").trim()}:updated`;
}

/**
 * The push payload for one kind of change.
 *
 * FCM data values must be strings, so every value is stringified here.
 */
export function changePushPayload(kind, payload = {}) {
  const data = { type: DATA_CHANGED_PUSH_TYPE, kind: String(kind ?? "").trim() };
  for (const [k, v] of Object.entries(payload ?? {})) {
    if (k === "kind") continue;
    data[k] = v == null ? "" : String(v);
  }
  return data;
}

/**
 * Announce one owner change.
 *
 * [kind] is one of CHANGE_KINDS. [payload] is anything the clients can use
 * (the changed id, the code, ...). It travels with the frame and the push so
 * a client can react without guessing.
 */
export async function announceChange(kind, payload = {}) {
  const name = String(kind ?? "").trim();
  if (!name) return;
  const body = { kind: name, ...payload };
  try {
    emit(changeEventName(name), body);
  } catch {
    // A broken stream must never fail the mutation.
  }
  try {
    await sendDevicePush(DATA_CHANGED_PUSH_TYPE, changePushPayload(name, body));
  } catch {
    // The phone still picks the change up on its next poll.
  }
}
