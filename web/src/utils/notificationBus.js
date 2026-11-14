/**
 * Keeps the dashboard toast and the notification center entry in step.
 *
 * Every toast the dashboard raises has a matching record in the bell: a
 * recorded shift writes a SHIFT alert, a card registration writes a
 * RFID_BOUND alert, and so on. The record is written by the server BEFORE the
 * toast is raised, so the bell only has to fetch it - but the bell normally
 * refetches on the SSE event with a short debounce, which can put the entry a
 * beat behind the toast.
 *
 * The hooks that raise a toast call requestBellRefresh() right after they do,
 * so the bell fetches the new entry at once and the toast and the record
 * appear together.
 *
 * A plain module bus on purpose: the bell and the toast hooks live in
 * different parts of the tree, and this is a signal, not state.
 */

const listeners = new Set();

/** Subscribe to "the bell should fetch now". Returns an unsubscribe function. */
export function onBellRefresh(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Ask the bell to fetch its list right now. Never throws. */
export function requestBellRefresh() {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      /* a broken listener must not break the toast that asked for it */
    }
  }
}
