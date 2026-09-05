// Single badge primitive for the whole app.
//
// Canonical variants: ok | warn | danger | info | neutral | brand
// Legacy aliases still accepted (low, critical, read, loc) so old
// call sites keep working — write new code with canonical names.
// Visuals live in chips.css; this file is the only place that maps
// variant -> class, so a future rename touches one file.
const ALIAS = {
  low: "warn",
  critical: "danger",
  read: "neutral",
  loc: "info",
};

const CLASS = {
  ok: "ok",
  warn: "low",
  danger: "critical",
  info: "info",
  neutral: "read",
  brand: "brand",
};

export const BADGE_VARIANTS = Object.keys(CLASS);

export default function Badge({ variant = "neutral", className = "", ...rest }) {
  const canonical = ALIAS[variant] ?? variant;
  const cls = CLASS[canonical] ?? "read";
  return (
    <span className={`chip ${cls}${className ? ` ${className}` : ""}`} {...rest} />
  );
}
