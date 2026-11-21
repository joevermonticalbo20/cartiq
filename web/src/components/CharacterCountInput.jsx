import { useState } from "react";

const DEFAULT_MAX_LENGTH = 50;

export default function CharacterCountInput({
  maxLength,
  onBlur,
  onChange,
  onFocus,
  ...inputProps
}) {
  const [focused, setFocused] = useState(false);
  const [uncontrolledValue, setUncontrolledValue] = useState(
    String(inputProps.defaultValue ?? ""),
  );
  const value = inputProps.value === undefined
    ? uncontrolledValue
    : String(inputProps.value ?? "");
  const count = value.length;
  const limit = maxLength ?? DEFAULT_MAX_LENGTH;

  return (
    <div className="character-count-input">
      <input
        {...inputProps}
        maxLength={limit}
        onChange={(event) => {
          setUncontrolledValue(event.target.value);
          onChange?.(event);
        }}
        onFocus={(event) => {
          setFocused(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          onBlur?.(event);
        }}
      />
      {focused && count > 0 && (
        <span className="character-count">
          {count}/{limit}
        </span>
      )}
    </div>
  );
}
