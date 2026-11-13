import { describe, it, expect } from "vitest";

import { timeClockScheduleError } from "./timeClock.js";

describe("timeClockScheduleError", () => {
  it("refuses a Time out that is earlier than the Time in", () => {
    // The owner's example: time in 4:00-4:10 PM, time out 3:00-3:10 PM.
    const error = timeClockScheduleError({
      inOpen: "16:00",
      inClose: "16:10",
      outOpen: "15:00",
      outClose: "15:10",
    });
    expect(error).toMatch(/Time out cannot be earlier than Time in/);
  });

  it("refuses a Time out that opens before the Time in opens", () => {
    expect(
      timeClockScheduleError({
        inOpen: "06:00",
        inClose: "08:00",
        outOpen: "05:00",
        outClose: "23:00",
      }),
    ).toBeTruthy();
  });

  it("refuses a Time out that closes before the Time in closes", () => {
    expect(
      timeClockScheduleError({
        inOpen: "06:00",
        inClose: "08:00",
        outOpen: "09:00",
        outClose: "07:30",
      }),
    ).toBeTruthy();
  });

  it("allows a normal schedule", () => {
    expect(
      timeClockScheduleError({
        inOpen: "07:00",
        inClose: "09:00",
        outOpen: "17:00",
        outClose: "19:00",
      }),
    ).toBeNull();
  });

  it("allows the all-day schedule", () => {
    // Both windows cover the whole day: a real choice for a stall.
    expect(
      timeClockScheduleError({
        inOpen: "00:00",
        inClose: "23:59",
        outOpen: "00:00",
        outClose: "23:59",
      }),
    ).toBeNull();
  });
});
