import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { deliver, plainEmail, signIn, state, uniqueSubject, waitForMail } from "./support.ts";

// A pending AI draft the reviewer doesn't want: they discard it, then ask the AI for a new one
// or write their own. Nothing reaches anyone until a draft is approved.

async function openPendingDraft(page: Page, subject: string) {
  await signIn(page);
  await page.getByRole("link", { name: subject }).click();
  await expect(page.getByTestId("draft-body")).toHaveText(state().draft);
  await expect(page.getByText("Waiting for approval")).toBeVisible();
}

async function repliesInMailpit(request: APIRequestContext, subject: string) {
  const res = await request.get(`${state().mailpitUrl}/api/v1/messages`);
  const { messages } = (await res.json()) as { messages: { Subject: string }[] };
  return messages.filter((m) => m.Subject === `Re: ${subject}`).length;
}

test("a pending draft is discarded, and the AI writes a new one", async ({ page, request }) => {
  const subject = uniqueSubject("Wrong size");
  await deliver(request, plainEmail(subject, "Hi, the shoes are too small."));
  await openPendingDraft(page, subject);

  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(
    page.getByText("The draft was discarded. Nothing has gone to the customer."),
  ).toBeVisible();
  await expect(page.getByTestId("draft-body")).toBeHidden();
  await expect(page.getByRole("button", { name: "Approve & send" })).toBeHidden();
  expect(await repliesInMailpit(request, subject)).toBe(0);

  await page.getByRole("button", { name: "Write a new draft" }).click();
  await expect(page.getByText("Waiting for approval")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("draft-body")).toHaveText(state().draft);
  expect(await repliesInMailpit(request, subject)).toBe(0);

  // Discarding the new one offers the choice again, not a draft that never comes.
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.getByRole("button", { name: "Write a new draft" })).toBeVisible();
  await expect(page.getByText("The AI is writing a draft…")).toBeHidden();
});

test("after a discard, a hand-written draft is saved and approved", async ({ page, request }) => {
  const subject = uniqueSubject("Gift wrap");
  await deliver(request, plainEmail(subject, "Hi, can you gift wrap my order?"));
  await openPendingDraft(page, subject);

  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await page.getByRole("button", { name: "Write my own" }).click();
  const mine = "Happy to! We'll gift wrap it at no charge.";
  await page.getByRole("textbox", { name: "Your reply" }).fill(mine);
  await page.getByRole("button", { name: "Save draft" }).click();

  const draft = page.getByTestId("draft-body");
  await expect(draft).toHaveText(mine);
  await expect(page.getByText("Waiting for approval")).toBeVisible();
  await page.getByRole("button", { name: "Approve & send" }).click();
  await expect(page.getByText("Sent", { exact: true })).toBeVisible({ timeout: 30_000 });

  // Still shadow mode: it goes to the owner, never the customer.
  const mail = await waitForMail(request, `Re: ${subject}`);
  expect(mail.to).toEqual([state().owner]);
  expect(mail.text).toContain(mine);
});
