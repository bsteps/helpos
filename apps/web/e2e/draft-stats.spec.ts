import { expect, test } from "@playwright/test";
import { state } from "./support.ts";

// The inbox's "approved unchanged" line, on the demo data: Northwind Cycles has three approved
// drafts in mid-January 2026, one of them edited by an agent first, so two of three went out
// as the AI wrote them.

test("the inbox shows how many drafts were approved unchanged", async ({ page }) => {
  // The demo data is dated; look at it from a few days after, so it falls in the last 14 days.
  await page.clock.setFixedTime(new Date("2026-01-20T12:00:00Z"));
  const { seedOwner, seedPassword } = state();
  await page.goto("/login");
  await page.getByLabel("Email").fill(seedOwner);
  await page.getByLabel("Password").fill(seedPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(page.getByText("Northwind Cycles")).toBeVisible();
  await expect(
    page.getByText("Last 14 days: 67% of drafts approved unchanged (2 of 3)"),
  ).toBeVisible();
});
