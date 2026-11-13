import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { deliver, plainEmail, signIn, state, uniqueSubject } from "./support.ts";

test("every screen is accessible and fits a phone with long content", async ({
  page,
  request,
}, testInfo) => {
  // One test walks every screen, waiting for animations and taking a full-page screenshot at
  // each stop, which takes longer than the default one-screen budget.
  test.setTimeout(180_000);
  const audit = async (screen: string) => {
    await test.step(screen, async () => {
      await page.evaluate(() => document.fonts.ready);
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              document
                .getAnimations()
                .filter(
                  (animation) =>
                    animation.playState === "running" &&
                    animation.effect?.getComputedTiming().iterations !== Infinity,
                ).length,
          ),
        )
        .toBe(0);
      if (testInfo.project.name === "laptop") {
        const results = await new AxeBuilder({ page }).analyze();
        expect
          .soft(
            results.violations.filter(
              ({ impact }) => impact === "serious" || impact === "critical",
            ),
            `${screen}: serious or critical accessibility violations`,
          )
          .toEqual([]);
      } else {
        const viewport = page.viewportSize();
        if (!viewport) throw new Error("Phone sweep requires a fixed viewport");
        const contentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        expect
          .soft(contentWidth, `${screen}: horizontal overflow`)
          .toBeLessThanOrEqual(viewport.width);
      }
      await testInfo.attach(screen, {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
      });
    });
  };

  await page.goto("/login");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await audit("Login");
  await page.goto(state().passwordSetupLink);
  await expect(page.getByLabel("New password")).toBeVisible();
  await expect(page.getByLabel("Repeat it")).toBeVisible();
  await audit("Set password form");
  await page.goto("/set-password");
  await expect(page.getByText(/This page needs the full link/)).toBeVisible();
  await audit("Set password missing link");

  const subject = uniqueSubject(`Sweep-${"s".repeat(240)}`);
  const conversationId = await deliver(request, plainEmail(subject, "Please help with my order."));
  await signIn(page);
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  const me = await page.request.get("/v1/me");
  expect(me.status()).toBe(200);
  expect(await me.json()).toMatchObject({ actor: { type: "user" } });
  await expect(page.getByRole("link", { name: subject, exact: true })).toBeVisible();
  await audit("Inbox with long subject");

  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.getByTestId("shadow-mode-summary")).toBeVisible();
  await audit("Settings");
  await page.getByRole("button", { name: "Turn off shadow mode", exact: true }).click();
  await expect(page.getByRole("button", { name: "Send replies to customers" })).toBeVisible();
  await audit("Shadow mode confirmation");
  await page.getByRole("button", { name: "Keep shadow mode on" }).click();

  await page.goto(`/conversations/${conversationId}`);
  await expect(page.getByRole("heading", { name: subject, exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Conversation", exact: true })).toContainText(
    "Please help with my order.",
  );
  await expect(page.getByTestId("draft-body")).toHaveText(state().draft);
  await audit("Conversation with long subject and pending draft");
  await page
    .getByRole("region", { name: "Draft", exact: true })
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await expect(page.getByRole("textbox", { name: "Reply", exact: true })).toBeVisible();
  await audit("Draft edit form");
});
