import { describe, it, expect } from "vitest";
import { isUnreadAlert } from "./NotificationBell.jsx";

// The bell's badge logic. It used to read `status === "unread"`, which no
// API row ever carries — so the badge was permanently 0 and a new sale (a
// SALE alert with isRead:false) never lit it up.
describe("isUnreadAlert (bell badge logic)", () => {
  it("counts isRead=false rows (the API shape)", () => {
    expect(isUnreadAlert({ id: 1, isRead: false })).toBe(true);
    expect(isUnreadAlert({ id: 1, isRead: true })).toBe(false);
  });

  it("treats a missing isRead as unread (pre-upgrade alert docs)", () => {
    expect(isUnreadAlert({ id: 2 })).toBe(true);
  });

  it("respects an explicit read status", () => {
    expect(isUnreadAlert({ id: 3, isRead: false, status: "read" })).toBe(false);
  });

  it("handles null safely", () => {
    expect(isUnreadAlert(null)).toBe(false);
  });
});
