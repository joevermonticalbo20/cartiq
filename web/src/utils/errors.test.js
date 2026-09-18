import { describe, it, expect } from "vitest";
import { getFriendlyError } from "./errors.js";

describe("getFriendlyError", () => {
  it("keeps specific server messages verbatim (400/404/409)", () => {
    const err = { response: { status: 409, data: { error: 'Product "X" already exists' } } };
    expect(getFriendlyError(err, "Failed")).toBe('Product "X" already exists');
  });

  it("gives a plain denial for 403 even with a server message", () => {
    const err = { response: { status: 403, data: { error: "forbidden" } } };
    expect(getFriendlyError(err, "Failed")).toBe("You don't have permission to do that.");
  });

  it("gives a plain server-problem message for 5xx", () => {
    const err = { response: { status: 500, data: {} }, message: "Request failed with status code 500" };
    expect(getFriendlyError(err, "Failed")).toBe("The server had a problem. Try again in a bit.");
  });

  it("explains connection loss on timeouts", () => {
    const err = { code: "ECONNABORTED", message: "timeout of 10000ms exceeded" };
    expect(getFriendlyError(err, "Failed")).toMatch(/Cannot reach the server/);
  });

  it("explains connection loss on network errors", () => {
    const err = { message: "Network Error" };
    expect(getFriendlyError(err, "Failed")).toMatch(/Cannot reach the server/);
  });

  it("surfaces plain local error text", () => {
    expect(getFriendlyError(new Error("boom-500"), "Failed")).toBe("boom-500");
  });

  it("falls back when there is nothing useful", () => {
    expect(getFriendlyError({}, "Failed")).toBe("Failed");
  });

  it("reads ApiError shapes (status + data, no response)", () => {
    const err = { name: "ApiError", message: "gone", status: 404, data: null };
    expect(getFriendlyError(err, "Failed")).toBe("Not found. It may have been deleted.");
  });
});
