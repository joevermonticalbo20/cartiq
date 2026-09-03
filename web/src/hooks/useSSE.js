import { useEffect, useLayoutEffect, useRef } from "react";

/**
 * Subscribes to the CartIQ server-sent-events stream.
 * Auto-reconnects on disconnect (1s, 2s, 4s, 8s, max 30s).
 * Each event of the form `event: foo\ndata: {…}` is passed to `onEvent`.
 */
export function useSSE(path, { token, onEvent, onStatus } = {}) {
  const onEventRef = useRef(onEvent);
  const onStatusRef = useRef(onStatus);

  useLayoutEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useLayoutEffect(() => {
    onStatusRef.current = onStatus;
  }, [onStatus]);

  useEffect(() => {
    if (!token) return undefined;

    let es = null;
    let backoff = 1000;
    let cancelled = false;
    let timer = null;

    const open = () => {
      if (cancelled) return;
      onStatusRef.current?.("connecting");
      // EventSource can't send custom headers, so pass token via query string.
      const url = `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
      es = new EventSource(url);
      es.onopen = () => {
        backoff = 1000;
        onStatusRef.current?.("open");
      };
      es.onerror = () => {
        onStatusRef.current?.("down");
        es?.close();
        timer = setTimeout(open, backoff);
        backoff = Math.min(backoff * 2, 30000);
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

    open();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      es?.close();
    };
  }, [path, token]);
}
