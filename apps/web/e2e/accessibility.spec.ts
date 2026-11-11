import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { deliver, plainEmail, signIn, state, uniqueSubject } from "./support.ts";

test("every screen is accessible and fits a phone with long content", async ({
  page,
  request,
}, testInfo) => {
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

  await page.getByRole("link", { name: "Knowledge", exact: true }).click();
  const title = uniqueSubject("Sweep source");
  const url = `http://127.0.0.1/${"source".repeat(60)}-${crypto.randomUUID()}`;
  await page.getByRole("button", { name: "Add a source" }).click();
  await page.getByRole("button", { name: "Web page", exact: true }).click();
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("URL", { exact: true }).fill(url);
  await audit("Knowledge add source form");
  await page.getByRole("button", { name: "Add source", exact: true }).click();
  const card = page.getByTestId("knowledge-source").filter({ hasText: title });
  await expect(card.getByText(url, { exact: true })).toBeVisible();
  await expect(card.getByRole("link", { name: url, exact: true })).toHaveAttribute("href", url);
  await expect(card.getByText("Failed", { exact: true })).toBeVisible();
  await audit("Knowledge with long source URL");
  await card.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(card.getByRole("button", { name: "Save", exact: true })).toBeVisible();
  await audit("Knowledge edit form");
  await card.getByRole("button", { name: "Cancel", exact: true }).click();
  await card.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(card.getByRole("button", { name: "Keep", exact: true })).toBeVisible();
  await audit("Knowledge delete confirmation");
  await card.getByRole("button", { name: "Keep", exact: true }).click();

  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.getByText(/^(Connected|Not connected)$/)).toBeVisible();
  if (await page.getByRole("button", { name: "Disconnect", exact: true }).isVisible()) {
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(page.getByText("Not connected", { exact: true })).toBeVisible();
  }
  await page.getByLabel("Repository", { exact: true }).fill(state().githubRepo);
  await page.getByLabel("Personal access token").fill(state().githubToken);
  await audit("Settings connection form");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByTestId("webhook-secret")).toHaveText(/^[0-9a-f]{64}$/);
  await expect(page.getByTestId("webhook-url")).toContainText(
    "/v1/integrations/github/webhook?workspace=",
  );
  await audit("Settings with webhook secret");
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
  await page.getByRole("button", { name: "Create GitHub issue", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue(
    state().issueTitle,
  );
  await expect(page.getByRole("button", { name: "Create issue", exact: true })).toBeEnabled();
  await audit("GitHub issue confirmation");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("region", { name: "Draft", exact: true })
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await expect(page.getByRole("textbox", { name: "Reply", exact: true })).toBeVisible();
  await audit("Draft edit form");
});
