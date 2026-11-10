import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { useSSE } from "./useSSE.js";
import { useLiveEvent, useLiveStream } from "./useLiveStream.js";
import { LIVE_EVENT_NAMES, LIVE_EVENTS } from "./liveEvents.js";

class FakeEventSource {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.closed = false;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  emit(type, data) {
    for (const fn of this.listeners[type] ?? []) {
      fn({ type, data: JSON.stringify(data) });
    }
  }
  close() {
    this.closed = true;
  }
}

/** Every source file under web/src, so a call site cannot be missed. */
function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(js|jsx)$/.test(entry)) out.push(full);
  }
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("live event registry", () => {
  it("registers every event name the app subscribes to", () => {
    // A `useLiveEvent("x")` call with a name that is not in the registry is a
    // subscription that can never fire: the server sends named frames and only
    // the registered names reach the app.
    const files = sourceFiles(join(process.cwd(), "src")).filter(
      (f) => !f.includes("liveEvents.test.js")
    );
    const used = new Set();
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/useLiveEvent\(\s*"([^"]+)"/g)) used.add(m[1]);
      for (const m of text.matchAll(/useLiveEvent\(\s*LIVE_EVENTS\.(\w+)/g)) {
        const key = m[1];
        const value = LIVE_EVENTS[key];
        expect(value, `${key} is not a known LIVE_EVENTS constant`).toBeTruthy();
        used.add(value);
      }
    }
    expect(used.size).toBeGreaterThan(0);
    for (const name of used) {
      expect(
        LIVE_EVENT_NAMES,
        `"${name}" is subscribed to but never registered on the stream`,
      ).toContain(name);
    }
  });

  it("keeps the constants and the registry in sync", () => {
    for (const value of Object.values(LIVE_EVENTS)) {
      expect(LIVE_EVENT_NAMES).toContain(value);
    }
  });
});

describe("useSSE named events", () => {
  it("adds a listener for every registered event name", async () => {
    renderHook(() => useSSE("/api/events", { getTicket: async () => "t" }));
    await act(async () => {});
    const es = FakeEventSource.instances[0];
    for (const name of LIVE_EVENT_NAMES) {
      expect(es.listeners[name], `no listener for "${name}"`).toBeTruthy();
    }
  });

  it("delivers restock and RFID frames to their subscribers", async () => {
    // The frames the server really sends (api/src/routes/inventory.js,
    // services/rfid_bind.js). These used to be dropped because the connection
    // never listened for them.
    const restock = vi.fn();
    const rfid = vi.fn();
    renderHook(() =>
      useSSE("/api/events", {
        getTicket: async () => "t",
        onEvent: (name, data) => {
          if (name === LIVE_EVENTS.restockRequestNew) restock(data);
          if (name === LIVE_EVENTS.rfidBound) rfid(data);
        },
      })
    );
    await act(async () => {});
    const es = FakeEventSource.instances[0];
    act(() => es.emit("restock-request:new", { id: 7 }));
    act(() => es.emit("rfid:bound", { rfidUid: "04A2B3C4" }));
    expect(restock).toHaveBeenCalledWith({ id: 7 });
    expect(rfid).toHaveBeenCalledWith({ rfidUid: "04A2B3C4" });
  });
});

describe("useLiveEvent", () => {
  it("hands the payload to a subscriber through the shared stream", async () => {
    // The full path the app uses: useLiveStream() owns the connection and
    // feeds the shared dispatch map; useLiveEvent() subscribes to it.
    const handler = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ticket: "tick" }),
      })
    );
    renderHook(() => {
      useLiveStream();
      useLiveEvent(LIVE_EVENTS.restockRequestUpdated, handler);
    });
    await act(async () => {
      // fetchTicket() resolves through fetch() + res.json(), so the connection
      // needs a couple of microtask hops before it exists.
      await vi.waitFor(() => {
        expect(FakeEventSource.instances).toHaveLength(1);
      });
    });
    const es = FakeEventSource.instances[0];
    act(() => es.emit("restock-request:updated", { id: 9, status: "fulfilled" }));
    expect(handler).toHaveBeenCalledWith({ id: 9, status: "fulfilled" });
  });
});
