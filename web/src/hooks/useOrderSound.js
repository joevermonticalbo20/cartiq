import { useCallback, useEffect, useRef, useState } from "react";
import { createOrderChime, isAudioSupported } from "../utils/orderSound.js";

/**
 * Sound for incoming orders.
 *
 * Defaults to ON but is persisted so an operator can mute it for good, and it
 * only becomes audible once the page has seen a user gesture (autoplay policy).
 * `supported` is false on browsers with no Web Audio, and the UI hides the
 * toggle entirely there rather than offering a control that cannot work.
 */

const STORAGE_KEY = "cartiq_order_sound";

function readStored() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === null ? true : v === "1";
  } catch {
    return true;
  }
}

function writeStored(on) {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
  } catch {
    /* private mode - the setting just won't persist */
  }
}

/** Mount once in the shell. Returns { enabled, setEnabled, supported, unlock }. */
export function useOrderSound() {
  const supported = isAudioSupported();
  const [enabled, setEnabledState] = useState(readStored);
  const chimeRef = useRef(null);

  // Lazily built in an effect, never during render: touching a ref while
  // rendering trips react-hooks/refs, and constructing an AudioContext during
  // render would also happen on a discarded render.
  useEffect(() => {
    if (!supported || chimeRef.current) return;
    chimeRef.current = createOrderChime();
  }, [supported]);

  const setEnabled = useCallback((next) => {
    setEnabledState(next);
    writeStored(next);
    // Turning it on from a click is itself the gesture that unlocks audio.
    if (next) chimeRef.current?.unlock();
  }, []);

  // Any first interaction unlocks the context for later chime plays.
  useEffect(() => {
    if (!supported) return undefined;
    const unlock = () => chimeRef.current?.unlock();
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [supported]);

  const play = useCallback(() => {
    if (!enabled) return false;
    return chimeRef.current?.play() ?? false;
  }, [enabled]);

  return { enabled, setEnabled, play, supported };
}