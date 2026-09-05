// Single button primitive for the whole app.
//
// Variants map to buttons.css: primary (bare button), ghost, danger.
// Sizes: default, small (small-btn). Icon-only usage MUST pass an
// aria-label — there is no visible text to announce.
const VARIANTS = {
  primary: "",
  ghost: "ghost",
  danger: "danger",
};

export default function Button({
  variant = "primary",
  small = false,
  type = "button",
  className = "",
  ...rest
}) {
  const cls = [VARIANTS[variant] ?? "", small ? "small-btn" : "", className]
    .filter(Boolean)
    .join(" ");
  return <button type={type} className={cls || undefined} {...rest} />;
}
