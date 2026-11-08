import { expect, test } from "@playwright/test";
import { ownerPassword, state } from "./support.ts";

// Runs once, before the laptop and phone projects: the owner created by `helpos:init` sets a
// password through the one-time link it printed, as a new self-hoster would.

test("the owner sets a password through the one-time link, which then stops working", async ({
  page,
}) => {
  const { passwordSetupLink, owner } = state();
  await page.goto(passwordSetupLink);
  await expect(page.getByRole("heading", { name: /Set your .+ password/ })).toBeVisible();
  // The token never stays in the address bar or history.
  await expect(page).toHaveURL(/\/set-password$/);

  await page.getByLabel("New password").fill("too short");
  await page.getByLabel("Repeat it").fill("too short");
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByText("Use at least 12 characters.")).toBeVisible();

  await page.getByLabel("New password").fill(ownerPassword);
  await page.getByLabel("Repeat it").fill(ownerPassword);
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByText("Your password is set. Sign in with it.")).toBeVisible();

  await page.getByLabel("Email").fill(owner);
  await page.getByLabel("Password").fill(ownerPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(page.getByText("Acme Support")).toBeVisible();

  // The same link a second time: refused.
  await page.goto(passwordSetupLink);
  await page.getByLabel("New password").fill("someone else's password");
  await page.getByLabel("Repeat it").fill("someone else's password");
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByText(/expired or was already used/)).toBeVisible();
});
