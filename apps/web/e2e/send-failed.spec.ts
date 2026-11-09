import { expect, type Page, test } from "@playwright/test";
import { deliver, plainEmail, signIn, state, uniqueSubject, waitForMail } from "./support.ts";

// A reply that couldn't be sent: the e2e server's mail transport fails every attempt for these
// subjects until the dashboard retries, so the draft ends up "Not sent". From there the owner
// retries it (it goes out once, still in shadow mode) or discards it and asks for a new draft.

async function approveAndWaitForFailure(page: Page, subject: string): Promise<void> {
  await signIn(page);
  await page.getByRole("link", { name: subject }).click();
  await expect(page.getByTestId("draft-body")).toHaveText(state().draft);
  await page.getByRole("button", { name: "Approve & send" }).click();
  await expect(page.getByText("Not sent", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("send-failed-alert")).toContainText("This reply wasn't sent");
}

test("a reply that failed to send is retried from the ticket and arrives once", async ({
  page,
  request,
}) => {
  const subject = uniqueSubject(`Refund ${state().smtpDownMarker}`);
  await deliver(request, plainEmail(subject, "Hi, where is my refund?"));
  await approveAndWaitForFailure(page, subject);

  // Closed, it still stays in the inbox, flagged, while the customer hasn't heard back.
  await page.getByRole("button", { name: "Close ticket" }).click();
  await expect(page.getByText("Closed", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Inbox" }).first().click();
  const row = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: subject }) });
  await expect(row.getByText("Reply not sent")).toBeVisible();
  await expect(row.getByText("Closed", { exact: true })).toBeVisible();
  await row.getByRole("link", { name: subject }).click();

  await page.getByRole("button", { name: "Retry send" }).click();
  await expect(page.getByText("Sent", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("send-failed-alert")).toBeHidden();

  // Sent now, so the closed ticket leaves the inbox.
  await page.getByRole("link", { name: "Inbox" }).first().click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(page.getByRole("link", { name: subject })).toBeHidden();

  // Still shadow mode: it goes to the owner, never the customer, and only once.
  const mail = await waitForMail(request, `Re: ${subject}`);
  expect(mail.to).toEqual([state().owner]);
  expect(mail.text).toContain(state().draft);
  const res = await request.get(`${state().mailpitUrl}/api/v1/messages`);
  const { messages } = (await res.json()) as { messages: { Subject: string }[] };
  expect(messages.filter((m) => m.Subject === `Re: ${subject}`)).toHaveLength(1);
});

test("a reply that failed to send can be discarded, and a new draft asked for", async ({
  page,
  request,
}) => {
  const subject = uniqueSubject(`Invoice ${state().smtpDownMarker}`);
  await deliver(request, plainEmail(subject, "Hi, can I get an invoice?"));
  await approveAndWaitForFailure(page, subject);

  await page.getByRole("button", { name: "Discard" }).click();
  await expect(page.getByText("The reply that couldn't be sent was discarded.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry send" })).toBeHidden();

  await page.getByRole("button", { name: "Write a new draft" }).click();
  await expect(page.getByText("Waiting for approval")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("draft-body")).toHaveText(state().draft);
});

test("discarding a failed follow-up reply doesn't bring back the earlier sent one", async ({
  page,
  request,
}) => {
  const subject = uniqueSubject("Shipping question");
  const firstId = `<${crypto.randomUUID()}@customer.test>`;
  await deliver(
    request,
    plainEmail(subject, "Hi, when does my order ship?").replace(
      /^Message-ID: .*$/m,
      `Message-ID: ${firstId}`,
    ),
  );
  await signIn(page);
  await page.getByRole("link", { name: subject }).click();
  await expect(page.getByTestId("draft-body")).toHaveText(state().draft);
  await page.getByRole("button", { name: "Approve & send" }).click();
  await expect(page.getByText("Sent", { exact: true })).toBeVisible({ timeout: 30_000 });

  // The customer writes again on the same thread; this reply fails to send.
  const followUp = [
    "From: Jane Customer <jane@customer.test>",
    `To: ${state().mailbox}`,
    `Subject: Re: ${subject} ${state().smtpDownMarker}`,
    `Message-ID: <${crypto.randomUUID()}@customer.test>`,
    `In-Reply-To: ${firstId}`,
    `References: ${firstId}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Any news?",
  ].join("\n");
  await deliver(request, followUp);
  // The page doesn't poll while its newest reply is sent, so reload until the new draft is in.
  await expect(async () => {
    await page.reload();
    await expect(page.getByText("Waiting for approval")).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await page.getByRole("button", { name: "Approve & send" }).click();
  await expect(page.getByText("Not sent", { exact: true })).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Discard" }).click();
  await expect(page.getByText("The reply that couldn't be sent was discarded.")).toBeVisible();
  await expect(page.getByText("Sent", { exact: true })).toBeHidden();
});
