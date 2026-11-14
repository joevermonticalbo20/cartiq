import { describe, it, expect } from "vitest";
import { alertLink, alertLinkLabel, isSelfAnnouncedAlert } from "./alertLinks.js";

describe("alertLink", () => {
  it("routes sales and void requests to the Sales page", () => {
    expect(alertLink({ type: "SALE" })).toBe("/sales");
    expect(alertLink({ type: "sale" })).toBe("/sales");
    expect(alertLink({ type: "VOID_REQUEST" })).toBe("/sales/void-requests");
    expect(alertLinkLabel({ type: "VOID_REQUEST" })).toBe("Open void requests");
  });

  it("routes stock alerts to the Inventory page", () => {
    for (const type of ["RESTOCK_REQUEST", "restock_request", "LOW_STOCK", "Critical", "INVENTORY"]) {
      expect(alertLink({ type })).toBe("/inventory");
    }
  });

  it("falls back to the notifications list for unknown types", () => {
    expect(alertLink({ type: "UNKNOWN_CARD" })).toBe("/notifications");
    expect(alertLink({ type: "something-new" })).toBe("/notifications");
    expect(alertLink({})).toBe("/notifications");
    expect(alertLink(null)).toBe("/notifications");
  });
});

describe("isSelfAnnouncedAlert", () => {
  it("knows the alerts that already raise their own toast", () => {
    // A shift, a card registration, a card removal and every refused tap each
    // have a live toast of their own. The bell must show the alert but must
    // not say it again.
    expect(isSelfAnnouncedAlert({ type: "SHIFT" })).toBe(true);
    expect(isSelfAnnouncedAlert({ type: "shift" })).toBe(true);
    expect(isSelfAnnouncedAlert({ type: "RFID_BOUND" })).toBe(true);
    expect(isSelfAnnouncedAlert({ type: "RFID_UNBOUND" })).toBe(true);
    expect(isSelfAnnouncedAlert({ type: "RFID_UNREGISTERED" })).toBe(true);
    expect(isSelfAnnouncedAlert({ type: "RFID_CONFLICT" })).toBe(true);
    expect(isSelfAnnouncedAlert({ type: "RFID_WRONG_CART" })).toBe(true);
    expect(isSelfAnnouncedAlert({ type: "RFID_ALREADY_REGISTERED" })).toBe(true);
  });

  it("leaves every other alert to the bell's own toast", () => {
    expect(isSelfAnnouncedAlert({ type: "LOW_STOCK" })).toBe(false);
    expect(isSelfAnnouncedAlert({ type: "SALE" })).toBe(false);
    expect(isSelfAnnouncedAlert({ type: "TIMECLOCK_WINDOW" })).toBe(false);
    expect(isSelfAnnouncedAlert({})).toBe(false);
    expect(isSelfAnnouncedAlert(null)).toBe(false);
  });
});
