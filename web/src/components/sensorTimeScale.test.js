import { describe, it, expect } from "vitest";
import { pickTickStep, clockTicks, timeX } from "./sensorTimeScale.js";

const MIN = 60 * 1000;

describe("pickTickStep", () => {
  it("uses 5-minute steps for a 10-minute span", () => {
    expect(pickTickStep(10 * MIN)).toBe(5 * MIN);
  });

  it("uses 1-hour steps for a 3.5-hour span", () => {
    expect(pickTickStep(3.5 * 60 * MIN)).toBe(60 * MIN);
  });

  it("caps at 2-hour steps for very long spans", () => {
    expect(pickTickStep(48 * 60 * MIN)).toBe(2 * 60 * MIN);
  });
});

describe("clockTicks", () => {
  it("snaps to round clock times across an evening span", () => {
    const start = new Date("2026-09-04T21:37:00").getTime();
    const end = new Date("2026-09-05T01:14:00").getTime();
    const ticks = clockTicks(start, end);
    // First tick snaps up to 22:00, all on hour boundaries.
    expect(new Date(ticks[0]).getMinutes()).toBe(0);
    expect(ticks[0]).toBeGreaterThanOrEqual(start);
    expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(end);
    expect(ticks.length).toBeLessThanOrEqual(6);
  });

  it("never repeats a label (the triple 12:29 AM bug)", () => {
    const start = new Date("2026-09-04T21:37:00").getTime();
    const end = new Date("2026-09-05T01:14:00").getTime();
    const ticks = clockTicks(start, end);
    const labels = ticks.map((t) =>
      new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    );
    expect(new Set(labels).size).toBe(labels.length);
    expect([...ticks].sort((a, b) => a - b)).toEqual(ticks);
  });

  it("pins the ends when the span is shorter than one step", () => {
    const start = 1000;
    expect(clockTicks(start, start + 3 * MIN)).toEqual([start, start + 3 * MIN]);
  });

  it("returns a single tick for a zero span", () => {
    expect(clockTicks(5000, 5000)).toEqual([5000]);
  });
});

describe("timeX", () => {
  it("maps span ends to the axis padding", () => {
    expect(timeX(0, 0, 100, 8, 600)).toBe(8);
    expect(timeX(100, 0, 100, 8, 600)).toBe(592);
    expect(timeX(50, 0, 100, 8, 600)).toBe(300);
  });

  it("centers when there is no span", () => {
    expect(timeX(42, 42, 42, 8, 600)).toBe(300);
  });

  it("compresses bursts honestly: close samples sit adjacent", () => {
    const t0 = 1_000_000;
    const x0 = timeX(t0, t0, t0 + 3600 * 1000, 8, 600);
    const x1 = timeX(t0 + 60 * 1000, t0, t0 + 3600 * 1000, 8, 600);
    const x2 = timeX(t0 + 3600 * 1000, t0, t0 + 3600 * 1000, 8, 600);
    expect(x1 - x0).toBeLessThan((x2 - x1) / 10);
  });
});
