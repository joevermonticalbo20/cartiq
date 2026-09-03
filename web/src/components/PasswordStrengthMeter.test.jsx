import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import PasswordStrengthMeter, { evaluatePassword } from "./PasswordStrengthMeter.jsx";

describe("evaluatePassword", () => {
  it("returns empty for empty input", () => {
    expect(evaluatePassword("").level).toBe("empty");
  });
  it("rates single-lowercase as weak", () => {
    expect(evaluatePassword("abc").level).toBe("weak");
  });
  it("rates 2-of-4 as fair", () => {
    expect(evaluatePassword("abcdefg1").level).toBe("fair");
  });
  it("rates 3-of-4 as good", () => {
    expect(evaluatePassword("Abcdefg1").level).toBe("good");
  });
  it("rates 4-of-4 as strong", () => {
    expect(evaluatePassword("Abcdefg1!").level).toBe("strong");
  });
});

describe("PasswordStrengthMeter", () => {
  it("renders a hidden input with the current level", () => {
    render(<PasswordStrengthMeter value="Abcdefg1!" />);
    const hidden = screen.getByDisplayValue("");
    expect(hidden.dataset.pwStrength).toBe("strong");
  });
  it("shows the requirement checklist when value is non-empty", () => {
    render(<PasswordStrengthMeter value="Abc1" />);
    expect(screen.getByText(/At least 8 characters/)).toBeInTheDocument();
  });
  it("marks passing checks with the ok class", () => {
    const { container } = render(<PasswordStrengthMeter value="Abcdefg1!" />);
    const digitCheck = container.querySelector('[data-check="digit"]');
    expect(digitCheck.className).toContain("ok");
  });
  it("does not render the checklist when value is empty", () => {
    const { container } = render(<PasswordStrengthMeter value="" />);
    expect(container.querySelector(".pw-strength-checks")).toBeNull();
  });
});
