import { expect, type Page, test } from "@playwright/test";
import { deliver, plainEmail, signIn, state, uniqueSubject, waitForMail } from "./support.ts";

async function openSettings(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
}

async function saveRecipient(page: Page, recipient: string): Promise<void> {
  await page.getByLabel("Shadow recipient").fill(recipient);
  await page.getByRole("button", { name: "Save recipient" }).click();
  await expect(page.getByTestId("shadow-mode-summary")).toHaveText(
    `Replies go to ${recipient}, not to customers.`,
  );
}

test("an owner changes the shadow recipient, and the next approved reply goes there", async ({
  page,
  request,
}) => {
  const { owner } = state();
  const reviewer = "reviewer@acme.test";
  await signIn(page);
  await openSettings(page);
  await expect(page.getByText("On", { exact: true })).toBeVisible();
  await expect(page.getByTestId("shadow-mode-summary")).toHaveText(
    `Replies go to ${owner}, not to customers.`,
  );

  await saveRecipient(page, reviewer);
  try {
    const subject = uniqueSubject("Password reset");
    await deliver(request, plainEmail(subject, "Hi, I can't reset my password."));
    await page.goto("/");
    await page.getByRole("link", { name: subject }).click();
    await expect(page.getByTestId("draft-body")).toHaveText(state().draft);
    await page.getByRole("button", { name: "Approve & send" }).click();
    await expect(page.getByText("Sent", { exact: true })).toBeVisible({ timeout: 30_000 });

    const mail = await waitForMail(request, `Re: ${subject}`);
    expect(mail.to).toEqual([reviewer]);
  } finally {
    await openSettings(page);
    await saveRecipient(page, owner);
  }
});

test("turning shadow mode off while the server locks it shows why", async ({ page }) => {
  await signIn(page);
  await openSettings(page);
  await page.getByRole("button", { name: "Turn off shadow mode" }).click();
  await expect(page.getByRole("alert")).toContainText("doesn't allow turning shadow mode off");
  await expect(page.getByText("On", { exact: true })).toBeVisible();
  await expect(page.getByTestId("shadow-mode-summary")).toContainText("not to customers");
});

const tokens = async (page: Page, testId: string): Promise<number> =>
  Number(((await page.getByTestId(testId).textContent()) ?? "").replace(/\D/g, ""));

const usedPlusLeft = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const read = (testId: string) =>
      Number(
        (document.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "").replace(/\D/g, ""),
      );
    return read("ai-usage-used") + read("ai-usage-remaining");
  });

test("AI usage shows today's tokens and budget, and grows after a draft", async ({
  page,
  request,
}) => {
  await signIn(page);
  await openSettings(page);
  await expect(page.getByText("Drafting", { exact: true })).toBeVisible();
  await expect(page.getByTestId("ai-usage-budget")).toHaveText(/\d/);
  const before = await tokens(page, "ai-usage-used");
  const budget = await tokens(page, "ai-usage-budget");
  await expect.poll(() => usedPlusLeft(page)).toBe(budget);

  const subject = uniqueSubject("Order status");
  await deliver(request, plainEmail(subject, "Hi, where is my order?"));
  await page.goto("/");
  await page.getByRole("link", { name: subject }).click();
  await expect(page.getByTestId("draft-body")).toHaveText(state().draft);

  await openSettings(page);
  await expect.poll(() => tokens(page, "ai-usage-used")).toBeGreaterThan(before);
  await expect.poll(() => usedPlusLeft(page)).toBe(budget);
});
