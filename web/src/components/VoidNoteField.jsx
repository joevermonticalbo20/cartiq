import { useEffect, useRef } from "react";
import { sanitizeVoidNoteTyping, validateVoidNote, VOID_NOTE_MAX, VOID_NOTE_MIN } from "../utils/voidNote.js";

/**
 * A note field for void confirmations. Strict rules:
 *   required, min 20, max 100 characters
 *   letters/digits and the characters ` , . - _ ` plus single spaces
 *   no run of three identical characters in a row (blocked at keystroke)
 *   single spaces between words
 * The parent reads the valid value through the ref or the onValid payload.
 */
export default function VoidNoteField({ value, onChange, error, onErrorChange, autoFocus = false }) {
  const ref = useRef(null);

  useEffect(() => {
    if (autoFocus) {
      const t = setTimeout(() => ref.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [autoFocus]);

  function handleChange(e) {
    onErrorChange("");
    onChange(sanitizeVoidNoteTyping(e.target.value));
  }

  return (
    <label className="field void-note-field">
      Reason for void *
      <textarea
        ref={ref}
        value={value}
        onChange={handleChange}
        onBlur={() => onErrorChange(validateVoidNote(value).error ?? "")}
        spellCheck={false}
        rows={3}
        maxLength={VOID_NOTE_MAX}
        className={error ? "input-invalid" : undefined}
        aria-invalid={error ? "true" : undefined}
        aria-describedby="void-note-error"
        aria-label="Reason for void"
        placeholder="Why is this order being voided? (e.g. wrong item punched, customer allergy, duplicate entry)"
      />
      <div className="void-note-meta">
        <span id="void-note-count" className="muted small">
          {value.length}/{VOID_NOTE_MAX}
        </span>
        {value.length < VOID_NOTE_MIN && (
          <span className="muted small">minimum {VOID_NOTE_MIN} characters</span>
        )}
      </div>
      {error && (
        <p id="void-note-error" className="field-error" role="alert">{error}</p>
      )}
    </label>
  );
}
