import { expect, test } from "@playwright/test";
import { ownerPassword, state } from "./support.ts";

test("sign-in alerts preserve entered values and keyboard submission", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/login?passwordSet=true");
  await expect(page.getByRole("status")).toHaveText("Your password is set. Sign in with it.");
  const email = page.getByLabel("Email");
  const password = page.getByLabel("Password");
  await email.fill(state().owner);
  await password.fill("wrong password");
  await password.press("Enter");
  await expect(page.getByRole("alert")).toHaveText("Wrong email or password.");
  await expect(email).toHaveValue(state().owner);
  await expect(password).toHaveValue("wrong password");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
  await password.fill(ownerPassword);
  await password.press("Enter");
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
