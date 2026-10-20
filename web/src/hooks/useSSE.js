import { useEffect, useLayoutEffect, useRef } from "react";

/**
 * Subscribes to the CartIQ server-sent-events stream.
 * Auto-reconnects on disconnect (1s, 2s, 4s, 8s, max 30s).
 * Each event of the form `event: foo\ndata: {…}` is passed to `onEvent`.
 *
 * Auth: EventSource can't send headers, so every (re)connect first asks
 * `getTicket()` for a short-lived stream ticket (POST /events/ticket).
 * The long-lived JWT never appears in a URL.
 */
export function useSSE(path, { getTicket, onEvent, onStatus } = {}) {
  const onEventRef = useRef(onEvent);
  const onStatusRef = useRef(onStatus);
  const getTicketRef = useRef(getTicket);

  useLayoutEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useLayoutEffect(() => {
    onStatusRef.current = onStatus;
  }, [onStatus]);

  useLayoutEffect(() => {
    getTicketRef.current = getTicket;
  }, [getTicket]);

  useEffect(() => {
    let es = null;
    let backoff = 1000;
    let cancelled = false;
    let paused = false;
    let timer = null;

    const scheduleReconnect = () => {
      if (cancelled || paused) return;
      onStatusRef.current?.("down");
      timer = setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 30000);
    };

    /** Close the current stream without letting a pending error reconnect. */
    const closeStream = () => {
      const old = es;
      es = null;
      if (old) {
        old.onerror = null;
        old.close();
      }
    };

    const open = async () => {
      if (cancelled || paused) return;
      // Never leave an old connection behind: a second EventSource would double
      // the server's polling for the same tab.
      closeStream();
      onStatusRef.current?.("connecting");
      let ticket = null;
      try {
        ticket = await getTicketRef.current?.();
      } catch {
        ticket = null;
      }
      if (cancelled || paused) return;
      if (!ticket) {
        scheduleReconnect();
        return;
      }
      const url = `${path}${path.includes("?") ? "&" : "?"}ticket=${encodeURIComponent(ticket)}`;
      try {
        es = new EventSource(url);
      } catch {
        scheduleReconnect();
        return;
      }
      es.onopen = () => {
        backoff = 1000;
        onStatusRef.current?.("open");
      };
      es.onerror = () => {
        es?.close();
        scheduleReconnect();
      };
      es.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          onEventRef.current?.(e.type || "message", data);
        } catch {
          /* ignore non-JSON */
        }
      };
      // Common named events
      ["order:new", "alert:new", "staff:on_shift", "sensor:reading", "connected"].forEach((evt) => {
        es.addEventListener(evt, (e) => {
          try {
            const data = JSON.parse(e.data);
            onEventRef.current?.(evt, data);
          } catch {
            /* ignore */
          }
        });
      });
    };

    /**
     * Pause the stream while the tab is hidden.
     *
     * The server polls Firestore every 15s for every open stream, so a
     * dashboard left open overnight kept spending the daily read budget for
     * events nobody could see. Closing the connection while hidden makes the
     * cost of an idle tab ~0 instead of ~2.4k reads/hour, and the stream
     * resumes with a fresh ticket as soon as the tab is looked at again.
     *
     * The trade-off: a notification that arrives while the tab is hidden is
     * not delivered live. It is still picked up on the next visible refresh,
     * and the mobile app is unaffected - it does not use this stream.
     */
    const onVisibilityChange = () => {
      if (typeof document === "undefined") return;
      if (document.hidden) {
        paused = true;
        clearTimeout(timer);
        closeStream();
        onStatusRef.current?.("paused");
        return;
      }
      if (cancelled) return;
      paused = false;
      backoff = 1000;
      open();
    };

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }

    open().catch(() => {
      if (!cancelled) onStatusRef.current?.("down");
    });

    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
      closeStream();
    };
  }, [path, getTicket]);
}
