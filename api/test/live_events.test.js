import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { formatEvent } from "../src/routes/events.js";

// The live stream is the dashboard's "it changed, refresh yourself" channel.
//
// A frame is NAMED ("event: product:updated"). A named frame only reaches the
// listeners registered for that exact name - the web's LIVE_EVENT_NAMES
// registry - so both the name and the payload shape are contract, not
// cosmetics. The Edge copy builds the same frame in sseEncode().
describe("live event frames", () => {
  it("names the event and carries the payload as JSON", () => {
    const frame = formatEvent("product:updated", { id: 7, name: "BBQ Fries" });
    assert.ok(frame.startsWith("event: product:updated\n"), "the frame must name the event");
    assert.ok(frame.endsWith("\n\n"), "a frame ends with a blank line");

    const payload = JSON.parse(frame.split("data: ")[1]);
    assert.equal(payload.id, 7);
    assert.equal(payload.name, "BBQ Fries");
  });

  it("stamps every frame with a time", () => {
    const payload = JSON.parse(formatEvent("inventory:updated", {}).split("data: ")[1]);
    assert.equal(typeof payload._time, "string");
    assert.ok(!Number.isNaN(Date.parse(payload._time)), "_time must be a real timestamp");
  });

  it("keeps the catalog payloads flat and small", () => {
    // The dashboard only needs "something moved" - it refetches what it
    // shows. A fat frame would cost bandwidth on every connected cart.
    const frame = formatEvent("inventory:updated", {
      name: "BBQ Powder",
      locationId: 3,
      action: "adjusted",
    });
    assert.equal(frame.match(/^event: /gm)?.length, 1, "one event line");
    assert.equal(frame.match(/^data: /gm)?.length, 1, "one data line");
    assert.ok(frame.endsWith("\n\n"), "a frame ends with a blank line");
    const payload = JSON.parse(frame.split("data: ")[1]);
    assert.deepEqual(Object.keys(payload).sort(), ["_time", "action", "locationId", "name"]);
  });
});
