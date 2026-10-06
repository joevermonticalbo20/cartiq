import { useEffect, useLayoutEffect, useRef } from "react";
import { API_BASE } from "../api.js";
import { useSSE } from "./useSSE.js";

/**
 * One app-wide server-sent-events connection.
 *
 * Why this exists: the stream used to be mounted inside DashboardPage only, so
 * an order placed on the POS was silent on every other screen (Sales,
 * Inventory, Analytics...) and the connection died on each navigation. Now a
 * single connection lives in the app shell (Layout) and components subscribe
 * to the events they care about. That keeps one ticket / one EventSource while
 * making the events reachable from anywhere.
 *
 * Use `useLiveStream()` once, in the shell. Use `useLiveEvent(name, handler)`
 * in any component that needs to react.
 */

const listeners = new Map(); // event name -> Set<handler>
const statusListeners = new Set(); // connection status -> Set<handler>

function dispatch(event, data) {
  const set = listeners.get(event);
  if (!set) return;
  for (const handler of [...set]) {
    // One bad subscriber must not stop delivery to the others.
    try {
      handler(data);
    } catch {
      /* subscriber errors are not the stream's problem */
    }
  }
}

/** Ask the API for a short-lived stream ticket (the JWT never hits a URL). */
async function fetchTicket() {
  try {
    const token =
      localStorage.getItem("cartiq_token") ??
      sessionStorage.getItem("cartiq_token") ??
      "";
    const res = await fetch(`${API_BASE}/events/ticket`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: "{}",
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.ticket ?? null;
  } catch {
    return null;
  }
}

/**
 * Mounts the single SSE connection. Call from the app shell only.
 *
 * Takes no arguments on purpose: `useSSE` re-runs its connect effect whenever
 * the `getTicket` identity changes, so passing an inline callback would
 * reconnect (and re-mint a ticket) on every single render. `fetchTicket` is a
 * module-level function, so its identity is stable for the app's lifetime.
 */
export function useLiveStream() {
  useSSE(`${API_BASE}/events`, {
    getTicket: fetchTicket,
    onEvent: dispatch,
    onStatus: (status) => {
      for (const handler of [...statusListeners]) {
        try {
          handler(status);
        } catch {
          /* ignore */
        }
      }
    },
  });
}

/** Subscribe to one event name. `handler` is read through a ref, so it may
 *  change every render without resubscribing. */
export function useLiveEvent(event, handler) {
  const handlerRef = useRef(handler);

  useLayoutEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    if (typeof handlerRef.current !== "function") return undefined;
    const wrapped = (data) => handlerRef.current(data);
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(wrapped);
    return () => {
      set.delete(wrapped);
    };
  }, [event]);
}

/** Subscribe to connection status changes ("open" | "connecting" | "down"). */
export function useLiveStatus(handler) {
  const handlerRef = useRef(handler);

  useLayoutEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    if (typeof handlerRef.current !== "function") return undefined;
    const wrapped = (status) => handlerRef.current(status);
    statusListeners.add(wrapped);
    return () => {
      statusListeners.delete(wrapped);
    };
  }, []);
}