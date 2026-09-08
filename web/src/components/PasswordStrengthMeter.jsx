export function evaluatePassword(pw = "") {
  const checks = {
    length: pw.length >= 8,
    case: /[a-z]/.test(pw) && /[A-Z]/.test(pw),
    digit: /\d/.test(pw),
    special: /[^A-Za-z0-9]/.test(pw),
  };

  const passed = Object.values(checks).filter(Boolean).length;

  let level = "empty";
  if (pw.length > 0 && passed <= 1) level = "weak";
  else if (passed === 2) level = "fair";
  else if (passed === 3) level = "good";
  else if (passed === 4) level = "strong";

  return { checks, passed, level };
}

const LEVEL_LABEL = {
  empty: "Start typing to check strength",
  weak: "Weak",
  fair: "Fair",
  good: "Good",
  strong: "Strong",
};

const REQUIREMENTS = [
  { key: "length", label: "At least 8 characters" },
  { key: "case", label: "Uppercase and lowercase letters" },
  { key: "digit", label: "At least one number" },
  { key: "special", label: "At least one special character" },
];

export default function PasswordStrengthMeter({ value = "", minLevel = null }) {
  const { checks, level } = evaluatePassword(value);
  const showChecks = value.length > 0;
  
  const meetsMin = !minLevel || level === "strong" || level === "good" ||
    (minLevel === "fair" && ["fair", "good", "strong"].includes(level)) ||
    (minLevel === "weak" && ["weak", "fair", "good", "strong"].includes(level));

  return (
    <div className="pw-strength" data-level={level}>
      <div className="pw-strength-bar" aria-hidden="true">
        <span /><span /><span /><span />
      </div>
      <div className="pw-strength-meta">
        <span className="pw-strength-label" aria-live="polite">
          {LEVEL_LABEL[level]}
        </span>
        {minLevel && !meetsMin && (
          <span className="pw-strength-warn" role="status">
            Min strength required: {minLevel}
          </span>
        )}
      </div>
      {showChecks && (
        <ul className="pw-strength-checks">
          {REQUIREMENTS.map((req) => (
            <li
              key={req.key}
              className={checks[req.key] ? "ok" : "fail"}
              data-check={req.key}
            >
              <span className="pw-check-mark" aria-hidden="true">
                {checks[req.key] ? "\u2713" : "\u00B7"}
              </span>
              {req.label}
            </li>
          ))}
        </ul>
      )}
      <input
        type="hidden"
        data-pw-strength={level}
        data-pw-meets-min={meetsMin ? "true" : "false"}
        readOnly
      />
    </div>
  );
}