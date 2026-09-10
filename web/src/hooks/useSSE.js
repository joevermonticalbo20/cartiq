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
    let timer = null;

    const scheduleReconnect = () => {
      if (cancelled) return;
      onStatusRef.current?.("down");
      timer = setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 30000);
    };

    const open = async () => {
      if (cancelled) return;
      onStatusRef.current?.("connecting");
      let ticket = null;
      try {
        ticket = await getTicketRef.current?.();
      } catch {
        ticket = null;
      }
      if (cancelled) return;
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

    open().catch(() => {
      if (!cancelled) onStatusRef.current?.("down");
    });

    return () => {
      cancelled = true;
      clearTimeout(timer);
      es?.close();
    };
  }, [path, getTicket]);
}
