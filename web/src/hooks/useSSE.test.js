import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSSE } from "./useSSE.js";

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
  emitRaw(type, raw) {
    for (const fn of this.listeners[type] ?? []) {
      fn({ type, data: raw });
    }
  }
  fail() {
    if (typeof this.onerror === "function") this.onerror({});
  }
  open() {
    if (typeof this.onopen === "function") this.onopen({});
  }
  close() {
    this.closed = true;
  }
}

describe("useSSE", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does nothing without a ticket provider", async () => {
    renderHook(() => useSSE("/api/events", {}));
    await act(async () => {});
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("connects with a fresh ticket in the query string", async () => {
    const onStatus = vi.fn();
    const getTicket = vi.fn().mockResolvedValue("tick-123");
    renderHook(() => useSSE("/api/events", { getTicket, onStatus }));
    await act(async () => {});
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe("/api/events?ticket=tick-123");
    expect(FakeEventSource.instances[0].url).not.toContain("cartiq_token");
    expect(onStatus).toHaveBeenCalledWith("connecting");
  });

  it("reports open and dispatches named events", async () => {
    const onEvent = vi.fn();
    const onStatus = vi.fn();
    renderHook(() =>
      useSSE("/api/events", {
        getTicket: async () => "t",
        onEvent,
        onStatus,
      })
    );
    await act(async () => {});
    const es = FakeEventSource.instances[0];
    act(() => es.open());
    expect(onStatus).toHaveBeenCalledWith("open");
    act(() => es.emit("order:new", { total: 40 }));
    expect(onEvent).toHaveBeenCalledWith("order:new", { total: 40 });
  });

  it("ignores non-JSON payloads", async () => {
    const onEvent = vi.fn();
    renderHook(() =>
      useSSE("/api/events", { getTicket: async () => "t", onEvent })
    );
    await act(async () => {});
    const es = FakeEventSource.instances[0];
    act(() => es.emitRaw("order:new", "not-json{{{"));
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("fetches a fresh ticket on every reconnect", async () => {
    const onStatus = vi.fn();
    const getTicket = vi.fn().mockResolvedValue("tick-1");
    renderHook(() => useSSE("/api/events", { getTicket, onStatus }));
    await act(async () => {});
    expect(getTicket).toHaveBeenCalledTimes(1);
    act(() => FakeEventSource.instances[0].fail());
    expect(onStatus).toHaveBeenCalledWith("down");
    expect(FakeEventSource.instances).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(getTicket).toHaveBeenCalledTimes(2);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("stays down without disconnecting the session when tickets fail", async () => {
    const onStatus = vi.fn();
    renderHook(() =>
      useSSE("/api/events", {
        getTicket: async () => null,
        onStatus,
      })
    );
    await act(async () => {});
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(onStatus).toHaveBeenCalledWith("down");
  });

  it("closes the stream on unmount", async () => {
    const { unmount } = renderHook(() =>
      useSSE("/api/events", { getTicket: async () => "t" })
    );
    await act(async () => {});
    const es = FakeEventSource.instances[0];
    unmount();
    expect(es.closed).toBe(true);
  });
});
