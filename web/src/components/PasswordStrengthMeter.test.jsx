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

describe("PasswordStrengthMeter minLevel gate", () => {
  function meetsMin(value, minLevel) {
    const { container } = render(
      <PasswordStrengthMeter value={value} minLevel={minLevel} />
    );
    return container.querySelector("input[type='hidden']").dataset.pwMeetsMin;
  }

  it("strong satisfies strong", () => {
    expect(meetsMin("Abcdefg1!", "strong")).toBe("true");
  });

  it("good does not satisfy strong", () => {
    const { container } = render(
      <PasswordStrengthMeter value="Abcdefg1" minLevel="strong" />
    );
    expect(container.querySelector("input[type='hidden']").dataset.pwMeetsMin).toBe("false");
    expect(screen.getByText(/Min strength required/)).toBeInTheDocument();
  });

  it("fair satisfies fair but weak does not", () => {
    expect(meetsMin("abcdefg1", "fair")).toBe("true");
    expect(meetsMin("abc", "fair")).toBe("false");
  });

  it("weak satisfies weak", () => {
    expect(meetsMin("abc", "weak")).toBe("true");
  });

  it("no minLevel always meets", () => {
    expect(meetsMin("abc", null)).toBe("true");
    expect(screen.queryByText(/Min strength required/)).toBeNull();
  });

  it("unknown minLevel never meets", () => {
    expect(meetsMin("Abcdefg1!", "bogus")).toBe("false");
  });
});
