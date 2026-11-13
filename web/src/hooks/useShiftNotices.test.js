import { describe, it, expect } from "vitest";

import { formatShiftNotice, SHIFT_EVENT_NAME } from "./useShiftNotices.js";
import { LIVE_EVENT_NAMES } from "./liveEvents.js";

describe("shift:new on the dashboard", () => {
  it("says who clocked in at which cart", () => {
    const notice = formatShiftNotice({
      staff_name: "Stall Staff 1",
      event: "IN",
      location_code: "CART-01",
      status: "recorded",
    });
    expect(notice.message).toBe("Stall Staff 1 timed in at CART-01");
    expect(notice.title).toBe("Time in");
    expect(notice.tone).toBe("success");
  });

  it("says timed out for a time out", () => {
    const notice = formatShiftNotice({
      staff_name: "Stall Staff 1",
      event: "OUT",
      location_code: "CART-01",
      status: "recorded",
    });
    expect(notice.message).toBe("Stall Staff 1 timed out at CART-01");
    expect(notice.title).toBe("Time out");
  });

  it("says nothing for a card on nobody's account", () => {
    // A stray tag is not news, and the POS app own toast covers the case where
    // the person at the cart needs to act.
    expect(
      formatShiftNotice({
        staff_name: null,
        event: "IN",
        location_code: "CART-01",
        status: "unregistered",
      }),
    ).toBeNull();
  });

  it("says nothing for a refused tap", () => {
    expect(
      formatShiftNotice({
        staff_name: "Stall Staff 1",
        event: "IN",
        location_code: "CART-01",
        status: "refused",
      }),
    ).toBeNull();
  });

  it("is the event name the tap route publishes", () => {
    expect(SHIFT_EVENT_NAME).toBe("shift:new");
    // The SSE connection only forwards the frames it knows about.
    expect(LIVE_EVENT_NAMES).toContain("shift:new");
  });
});
