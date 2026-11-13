import { describe, it, expect } from "vitest";

import { formatRfidUnregistered } from "./useRfidEvents.js";
import { LIVE_EVENT_NAMES } from "./liveEvents.js";

describe("rfid:unregistered", () => {
  it("names the card, the cart and what was refused", () => {
    const text = formatRfidUnregistered({
      rfidUid: "3A20704F",
      locationCode: "CART-01",
      event: "IN",
    });
    expect(text).toContain("3A20704F");
    expect(text).toContain("CART-01");
    expect(text).toContain("not registered");
    expect(text).toContain("clock in");
  });

  it("says clock out when that is what was pressed", () => {
    const text = formatRfidUnregistered({
      rfidUid: "3A20704F",
      locationCode: "CART-01",
      event: "OUT",
    });
    expect(text).toContain("clock out");
  });

  it("is a live event the dashboard listens for", () => {
    // The SSE connection only forwards the frames it knows about: an event
    // missing from the list is dropped before it reaches the page.
    expect(LIVE_EVENT_NAMES).toContain("rfid:unregistered");
  });
});
