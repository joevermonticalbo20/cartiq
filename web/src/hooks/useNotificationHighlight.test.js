import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import useNotificationHighlight from "./useNotificationHighlight.js";

describe("useNotificationHighlight", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("scrolls to the matching data row and clears the highlight after a short time", () => {
    vi.useFakeTimers();
    const target = document.createElement("tr");
    target.dataset.notificationTarget = "order:42";
    target.scrollIntoView = vi.fn();
    document.body.append(target);

    const { result } = renderHook(() => useNotificationHighlight("order:42", true));
    act(() => vi.advanceTimersByTime(0));

    expect(result.current).toBe("order:42");
    expect(target.scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });

    act(() => vi.advanceTimersByTime(3600));
    expect(result.current).toBeNull();
  });

  it("does not highlight a row before the page is ready", () => {
    const { result } = renderHook(() => useNotificationHighlight("order:42", false));
    expect(result.current).toBeNull();
  });
});
