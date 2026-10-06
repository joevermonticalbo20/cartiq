import { useCallback } from "react";

import { toast } from "../components/Toast.jsx";
import { useLiveEvent } from "./useLiveStream.js";

/**
 * Surfaces RFID card registrations on the web, live.
 *
 * A staff member registers their card by tapping it on the cart's reader, from
 * the POS app. That happens on a phone the owner is usually not looking at, so
 * without this the card simply appears in the database with nobody noticing.
 *
 * Deliberately mounted in the app shell rather than the Settings page: a
 * registration that lands while the owner is on the dashboard is the whole
 * point of the feature.
 */

/**
 * Pure formatter for one `rfid:bound` event. Exported so the wording is unit
 * tested rather than eyeballed.
 */
export function formatRfidBound(data) {
  const who = data?.name ?? data?.username ?? "A staff member";
  const uid = data?.rfidUid ?? "unknown card";
  const cart = data?.locationCode;
  // Re-registering drops the old card immediately; say so, or the owner finds
  // out from a tap that stopped working.
  const swap = data?.replacedExisting
    ? ` (replaced ${data.previousRfidUid ?? "their previous card"})`
    : "";
  const where = cart ? ` on ${cart}` : "";
  return `${who} registered card ${uid}${where}${swap}`;
}

/** `rfid:conflict` - somebody tapped a card that already has an owner. */
export function formatRfidConflict(data) {
  const holder = data?.holderName ?? "another account";
  const cart = data?.locationCode ?? "this cart";
  return `Card ${data?.rfidUid ?? "unknown"} on ${cart} is already registered to ${holder}`;
}

/**
 * Mount once in the app shell.
 *
 * [onChange] is called after every binding change so a page holding a staff
 * list can refetch instead of showing a stale card number.
 */
export function useRfidEvents({ onChange } = {}) {
  const handleBound = useCallback(
    (data) => {
      toast(formatRfidBound(data), "success");
      onChange?.(data);
    },
    [onChange],
  );

  const handleUnbound = useCallback(
    (data) => {
      toast(`${data?.name ?? "Staff"} removed card ${data?.rfidUid ?? ""}`, "warn");
      onChange?.(data);
    },
    [onChange],
  );

  const handleConflict = useCallback((data) => {
    toast(formatRfidConflict(data), "warn");
  }, []);

  useLiveEvent("rfid:bound", handleBound);
  useLiveEvent("rfid:unbound", handleUnbound);
  useLiveEvent("rfid:conflict", handleConflict);
}