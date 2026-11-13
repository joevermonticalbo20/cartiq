import { useCallback } from "react";

import { toast } from "../components/Toast.jsx";
import { useLiveEvent } from "./useLiveStream.js";

/**
 * Surfaces a card tap on the dashboard, live: a staff member timed in or out at
 * a cart.
 *
 * The tap happens on a phone at the cart, so the owner is usually not looking
 * at the Staff page when it lands. Without this the shift simply appears in
 * the database with nobody noticing - and "did my staff clock in?" is exactly
 * the question the reader exists to answer.
 *
 * Deliberately mounted in the app shell rather than the Staff page: a shift
 * that lands while the owner is on the dashboard is the whole point.
 */

/**
 * Pure formatter for one `shift:new` event. Exported so the wording - the part
 * the owner actually reads - is unit tested instead of eyeballed.
 *
 * Returns null when there is nothing worth saying: a tap of a card that is on
 * nobody's account is not news (it happens whenever somebody waves the wrong
 * tag), and a "refused" tap is left to the POS app, which is the one that has
 * to correct it.
 */
export function formatShiftNotice(data) {
  const status = String(data?.status ?? "recorded").toLowerCase();
  if (status !== "recorded") return null;
  const who = data?.staff_name ?? data?.staffName;
  if (!who) return null;
  const event = String(data?.event ?? "").toUpperCase();
  if (event !== "IN" && event !== "OUT") return null;
  const cart = data?.location_code ?? data?.locationCode ?? "the cart";
  const verb = event === "OUT" ? "timed out" : "timed in";
  return {
    message: `${who} ${verb} at ${cart}`,
    title: event === "OUT" ? "Time out" : "Time in",
    tone: event === "OUT" ? "info" : "success",
  };
}

/** Name of the event the tap routes publish. */
export const SHIFT_EVENT_NAME = "shift:new";

/**
 * Mount once in the app shell.
 *
 * [onChange] is called after a recorded shift so a page holding the staff list
 * can refetch instead of showing yesterday's attendance.
 */
export function useShiftNotices({ onChange } = {}) {
  const handle = useCallback(
    (data) => {
      const notice = formatShiftNotice(data);
      if (!notice) return;
      toast(notice.message, notice.tone);
      onChange?.(data);
    },
    [onChange],
  );

  useLiveEvent(SHIFT_EVENT_NAME, handle);
}
