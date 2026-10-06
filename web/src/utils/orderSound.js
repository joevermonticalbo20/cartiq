/**
 * Order-arrival chime.
 *
 * Synthesised with the Web Audio API instead of shipping an audio file: no
 * binary in the repo, no failed network fetch, and it stays in step with the
 * theme. Two short notes (an "order in" double-blip) rather than a long tone so
 * it is noticeable without being annoying during a busy service.
 *
 * Autoplay policy: browsers refuse to start audio until the page has had a user
 * gesture. `unlock()` is wired to the first pointer/key event, and every call is
 * wrapped so a blocked or unsupported context can never surface an error in the
 * UI. A silent chime is strictly better than a broken promise chain here.
 */

export function isAudioSupported() {
  if (typeof window === "undefined") return false;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  return typeof Ctor === "function";
}

export function createOrderChime() {
  if (!isAudioSupported()) {
    return { play: () => false, unlock: () => false, supported: false };
  }

  const Ctor = window.AudioContext || window.webkitAudioContext;
  let ctx = null;

  const ensure = () => {
    if (!ctx) {
      try {
        ctx = new Ctor();
      } catch {
        ctx = null;
      }
    }
    // A context created while the tab was hidden starts "suspended".
    if (ctx && ctx.state === "suspended" && typeof ctx.resume === "function") {
      try {
        ctx.resume().catch(() => {});
      } catch {
        /* ignore */
      }
    }
    return ctx;
  };

  /** Resume the context after a user gesture. Returns true when audio is live. */
  const unlock = () => {
    const c = ensure();
    return !!c;
  };

  const blip = (c, at, freq, gainValue) => {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    // Quick attack, exponential decay: reads as a "ping", not a "beep".
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(gainValue, at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.18);
    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(at);
    osc.stop(at + 0.2);
  };

  /** Plays the chime. Returns false when audio is unavailable or blocked. */
  const play = () => {
    const c = ensure();
    if (!c) return false;
    try {
      const t0 = c.currentTime + 0.01;
      blip(c, t0, 880, 0.14);
      blip(c, t0 + 0.14, 1320, 0.12);
      return true;
    } catch {
      return false;
    }
  };

  return { play, unlock, supported: true };
}