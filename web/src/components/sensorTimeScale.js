// Pure time-scale helpers for the sensor chart (SensorPanel.jsx).
// X-position is clock time, never sample order, so bursty data
// renders honestly instead of stretching across dead time.

export const TICK_STEPS_MS = [
  5 * 60 * 1000,
  10 * 60 * 1000,
  15 * 60 * 1000,
  30 * 60 * 1000,
  60 * 60 * 1000,
  2 * 60 * 60 * 1000,
];

/** Smallest step that yields at most `target` ticks across the span. */
export function pickTickStep(spanMs, target = 5) {
  for (const step of TICK_STEPS_MS) {
    if (spanMs / step <= target) return step;
  }
  return TICK_STEPS_MS[TICK_STEPS_MS.length - 1];
}

/**
 * Round clock ticks covering [startMs, endMs]: first tick snapped up
 * to the step boundary, so labels read 10:00 / 10:30, never 09:37.
 * Always distinct and ascending by construction.
 */
export function clockTicks(startMs, endMs, target = 5) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return [];
  const span = endMs - startMs;
  if (span <= 0) return [startMs];
  const step = pickTickStep(span, target);
  const ticks = [];
  for (let t = Math.ceil(startMs / step) * step; t <= endMs; t += step) {
    ticks.push(t);
  }
  // Span shorter than one step (or nothing snapped inside): pin the ends.
  if (ticks.length === 0) return [startMs, endMs];
  return ticks;
}

/** X pixel for a timestamp on a [padX, W - padX] axis. */
export function timeX(tsMs, startMs, endMs, padX, W) {
  const span = endMs - startMs;
  if (!(span > 0)) return padX + (W - padX * 2) / 2;
  return padX + ((tsMs - startMs) / span) * (W - padX * 2);
}
