import { test, expect } from "@playwright/test";

test("login page renders without a runtime error", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/CartIQ/);
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await expect(page.getByLabel("Username")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
});
