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
  const { shadowOwner, shadowMailbox, shadowPassword } = state();
  const reviewer = "reviewer@shadow-shop.test";
  await signIn(page, { email: shadowOwner, password: shadowPassword });
  await openSettings(page);
  await expect(page.getByText("On", { exact: true })).toBeVisible();
  await expect(page.getByTestId("shadow-mode-summary")).toHaveText(
    `Replies go to ${shadowOwner}, not to customers.`,
  );

  await saveRecipient(page, reviewer);
  try {
    const subject = uniqueSubject("Password reset");
    await deliver(request, plainEmail(subject, "Hi, I can't reset my password.", shadowMailbox));
    await page.goto("/");
    await page.getByRole("link", { name: subject }).click();
    await expect(page.getByTestId("draft-body")).toHaveText(state().draft);
    await page.getByRole("button", { name: "Approve & send" }).click();
    await expect(page.getByText("Sent", { exact: true })).toBeVisible({ timeout: 30_000 });

    const mail = await waitForMail(request, `Re: ${subject}`);
    expect(mail.to).toEqual([reviewer]);
  } finally {
    await openSettings(page);
    await saveRecipient(page, shadowOwner);
  }
});

test("turning shadow mode off asks first, and while the server locks it shows why", async ({
  page,
}) => {
  await signIn(page);
  await openSettings(page);
  await page.getByRole("button", { name: "Turn off shadow mode" }).click();
  await page.getByRole("button", { name: "Keep shadow mode on" }).click();
  await expect(page.getByText("Turn off shadow mode?")).toBeHidden();

  await page.getByRole("button", { name: "Turn off shadow mode" }).click();
  await page.getByRole("button", { name: "Send replies to customers" }).click();
  await expect(page.getByRole("alert")).toContainText("doesn't allow turning shadow mode off");
  await expect(page.getByText("On", { exact: true })).toBeVisible();
  await expect(page.getByTestId("shadow-mode-summary")).toContainText("not to customers");

  await page.getByRole("button", { name: "Turn off shadow mode" }).click();
  await expect(page.getByText("Turn off shadow mode?")).toBeVisible();
  await expect(page.getByText("doesn't allow turning shadow mode off")).toBeHidden();
});

const tokens = async (page: Page, testId: string): Promise<number> =>
  Number(((await page.getByTestId(testId).textContent()) ?? "").replace(/\D/g, ""));

const leftMatchesBudget = (page: Page, budget: number): Promise<boolean> =>
  page.evaluate((budget) => {
    const read = (testId: string) =>
      Number(
        (document.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "").replace(/\D/g, ""),
      );
    return read("ai-usage-remaining") === Math.max(0, budget - read("ai-usage-used"));
  }, budget);

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
  await expect.poll(() => leftMatchesBudget(page, budget)).toBe(true);

  const subject = uniqueSubject("Order status");
  await deliver(request, plainEmail(subject, "Hi, where is my order?"));
  await page.goto("/");
  await page.getByRole("link", { name: subject }).click();
  await expect(page.getByTestId("draft-body")).toHaveText(state().draft);

  await openSettings(page);
  await expect.poll(() => tokens(page, "ai-usage-used")).toBeGreaterThan(before);
  await expect.poll(() => leftMatchesBudget(page, budget)).toBe(true);
});

test("when drafting uses up the daily budget, Settings and the next ticket show drafting is paused", async ({
  page,
  request,
}) => {
  const { budgetOwner, budgetMailbox, budgetPassword } = state();
  await signIn(page, { email: budgetOwner, password: budgetPassword });
  await deliver(
    request,
    plainEmail(uniqueSubject("Spent budget"), "Hi, where is my bike?", budgetMailbox),
  );

  await openSettings(page);
  await expect(async () => {
    await page.reload();
    await expect(page.getByText("Paused", { exact: true })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await expect(page.getByTestId("ai-usage-remaining")).toHaveText("0");
  await expect(page.getByText("Drafting is paused")).toBeVisible();

  const subject = uniqueSubject("After the budget");
  await deliver(request, plainEmail(subject, "Hi, can you help me?", budgetMailbox));
  const row = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: subject }) });
  await expect(async () => {
    await page.goto("/");
    await expect(row.getByText("AI paused")).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await row.getByRole("link", { name: subject }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Today's AI budget for this workspace is spent",
  );
});
