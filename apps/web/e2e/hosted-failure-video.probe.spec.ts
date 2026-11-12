import { expect, test } from "@playwright/test";

test("intentional failure retains a hosted browser video", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
  await page.getByLabel("Email", { exact: true }).fill("video-proof@example.test");
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  expect(true, "Intentional artifact acceptance failure after the real login screen renders").toBe(
    false,
  );
});
