import { useEffect, useId, useRef, useState } from "react";
import { sanitizeVoidNoteTyping, validateVoidNote, VOID_NOTE_MAX } from "../utils/voidNote.js";

const DEFAULT_VOID_NOTE_OPTIONS = [
  { value: "Wrong item or quantity", label: "Wrong item or quantity" },
  { value: "Duplicate order", label: "Duplicate order" },
  { value: "Customer cancelled the order", label: "Customer cancelled the order" },
  { value: "Incorrect payment", label: "Incorrect payment" },
  { value: "Other / specific reason", label: "Other / type a specific reason" },
];

/**
 * A note field for the owner's decision notes (void + GCash confirm/decline).
 * Strict rules:
 *   required, min 20, max 100 characters
 *   letters/digits and the characters ` , . - _ ` plus single spaces
 *   no run of three identical characters in a row (blocked at keystroke)
 *   single spaces between words
 * The parent reads the valid value through onErrorChange/validateVoidNote.
 */
export default function VoidNoteField({
  value,
  onChange,
  error,
  onErrorChange,
  autoFocus = false,
  label = "Reason for void",
  placeholder = "Type the specific reason...",
  options = DEFAULT_VOID_NOTE_OPTIONS,
  editableTemplates = false,
}) {
  const ref = useRef(null);
  const radioGroupId = useId();
  const [focused, setFocused] = useState(false);
  const otherValue = "__other_void_reason__";
  const presetValues = options.map((option) => option.value).filter((optionValue) => optionValue !== otherValue);
  const [preset, setPreset] = useState(
    value && presetValues.includes(value) ? value : value ? otherValue : "",
  );
  // Live verdict for a single typed letter - shows before any blur/Set tap.
  const trimmed = value.trim();
  const liveError =
    trimmed.length === 1
      ? "A single letter is not valid - the minimum is 2."
      : "";
  const displayError = error || liveError;

  useEffect(() => {
    if (autoFocus) {
      const t = setTimeout(() => ref.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [autoFocus]);

  function handlePresetChange(e) {
    const nextPreset = e.target.value;
    onErrorChange("");
    setPreset(nextPreset);
    if (nextPreset === "" || nextPreset === otherValue) {
      onChange("");
    } else {
      onChange(nextPreset);
    }
  }

  function handleChange(e) {
    onErrorChange("");
    onChange(sanitizeVoidNoteTyping(e.target.value));
  }

  return (
    <div className="field void-note-field">
      <fieldset className="void-note-choices">
        <legend>{label} *</legend>
        {options.map((option) => (
          <label
            className={`void-note-choice${preset === (option.value === "Other / specific reason" ? otherValue : option.value) ? " is-selected" : ""}`}
            key={option.value}
          >
            <input
              type="radio"
              name={`void-note-choice-${radioGroupId}`}
              value={option.value === "Other / specific reason" ? otherValue : option.value}
              checked={preset === (option.value === "Other / specific reason" ? otherValue : option.value)}
              onChange={handlePresetChange}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </fieldset>

      {(preset === otherValue || (editableTemplates && preset !== "")) && (
        <label className="field void-note-specific">
          {preset === otherValue ? "Specific reason *" : "Decline message *"}
          <textarea
            ref={ref}
            value={value}
            onChange={handleChange}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              onErrorChange(validateVoidNote(value).error ?? "");
            }}
            spellCheck={false}
            rows={3}
            maxLength={VOID_NOTE_MAX}
            className={displayError ? "input-invalid" : undefined}
            aria-invalid={displayError ? "true" : undefined}
            aria-describedby="void-note-error"
            aria-label={preset === otherValue ? "Specific reason" : "Decline message"}
            placeholder={placeholder}
          />
          {focused && value.length > 0 && (
            <div className="void-note-meta">
              <span id="void-note-count" className="muted small">
                {value.length}/{VOID_NOTE_MAX}
              </span>
            </div>
          )}
        </label>
      )}
      {displayError && (
        <p id="void-note-error" className="field-error" role="alert">{displayError}</p>
      )}
    </div>
  );
}
