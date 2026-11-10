import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { deliver, plainEmail, signIn, state, uniqueSubject, waitForMail } from "./support.ts";

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

  await page
    .getByRole("region", { name: "Draft" })
    .getByRole("button", { name: "Discard" })
    .click();
  await expect(
    page.getByText("The draft was discarded. Nothing has gone to the customer."),
  ).toBeVisible();
  await expect(page.getByTestId("draft-body")).toBeHidden();
  await expect(page.getByRole("button", { name: "Approve & send" })).toBeHidden();
  await page.reload();
  await expect(page.getByRole("button", { name: "Ask the AI for a draft" })).toBeVisible();

  await page.getByRole("button", { name: "Ask the AI for a draft" }).click();
  await expect(page.getByText("Waiting for approval")).toBeVisible();
  await expect(page.getByTestId("draft-body")).toHaveText(state().draft);
  expect(await repliesInMailpit(request, subject)).toBe(0);

  await page
    .getByRole("region", { name: "Draft" })
    .getByRole("button", { name: "Discard" })
    .click();
  await expect(page.getByRole("button", { name: "Ask the AI for a draft" })).toBeVisible();
});

test("after a discard, a hand-written draft is saved and approved", async ({ page, request }) => {
  const subject = uniqueSubject("Gift wrap");
  await deliver(request, plainEmail(subject, "Hi, can you gift wrap my order?"));
  await openPendingDraft(page, subject);

  await page
    .getByRole("region", { name: "Draft" })
    .getByRole("button", { name: "Discard" })
    .click();
  await page.getByRole("button", { name: "Write my own" }).click();
  const mine = "Happy to! We'll gift wrap it at no charge.";
  await page.getByRole("textbox", { name: "Your reply" }).fill(mine);
  await page.getByRole("button", { name: "Save draft" }).click();

  await expect(page.getByTestId("draft-body")).toHaveText(mine);
  await expect(page.getByText("Waiting for approval")).toBeVisible();
  await page.getByRole("button", { name: "Approve & send" }).click();
  await expect(page.getByText("Sent", { exact: true })).toBeVisible();

  const mail = await waitForMail(request, `Re: ${subject}`);
  expect(mail.to).toEqual([state().owner]);
  expect(mail.text).toContain(mine);
});

test("a spent AI budget says so, and a hand-written draft still works", async ({
  page,
  request,
}) => {
  const subject = uniqueSubject("Late parcel");
  await deliver(request, plainEmail(subject, "Hi, my parcel is late."));
  await openPendingDraft(page, subject);
  await page
    .getByRole("region", { name: "Draft" })
    .getByRole("button", { name: "Discard" })
    .click();

  await page.route("**/v1/tickets/*/drafts", (route) =>
    route.request().method() === "POST" && route.request().postDataJSON()?.regenerate
      ? route.fulfill({ status: 409, json: { error: "daily_budget_reached" } })
      : route.fallback(),
  );
  await page.getByRole("button", { name: "Ask the AI for a draft" }).click();
  await expect(page.getByText("Today's AI budget is spent")).toBeVisible();

  await page.getByRole("button", { name: "Write my own" }).click();
  const mine = "Sorry about that. It's on the way and arrives tomorrow.";
  await page.getByRole("textbox", { name: "Your reply" }).fill(mine);
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByTestId("draft-body")).toHaveText(mine);
  await expect(page.getByText("Waiting for approval")).toBeVisible();
});

test("a discard the API refuses says so, and the draft stays", async ({ page, request }) => {
  const subject = uniqueSubject("Refund timing");
  await deliver(request, plainEmail(subject, "Hi, when does my refund land?"));
  await openPendingDraft(page, subject);

  await page.route("**/v1/drafts/*/discard", (route) =>
    route.fulfill({ status: 409, json: { error: "not_pending" } }),
  );
  await page
    .getByRole("region", { name: "Draft" })
    .getByRole("button", { name: "Discard" })
    .click();
  await expect(page.getByText("This reply changed since you opened it.")).toBeVisible();
  await expect(page.getByTestId("draft-body")).toHaveText(state().draft);
});

test("a closed ticket hides AI regeneration and rejects stale requests", async ({
  page,
  request,
}) => {
  const subject = uniqueSubject("Closed ticket draft");
  const ticketId = await deliver(request, plainEmail(subject, "Hi, I found the answer."));
  await openPendingDraft(page, subject);
  await page.getByRole("button", { name: "Close ticket" }).click();
  await expect(page.getByText("Closed", { exact: true })).toBeVisible();
  await page
    .getByRole("region", { name: "Draft" })
    .getByRole("button", { name: "Discard" })
    .click();
  await expect(page.getByTestId("draft-body")).toBeHidden();
  await expect(page.getByRole("button", { name: "Ask the AI for a draft" })).toBeHidden();
  const refused = await page.request.post(`/v1/tickets/${ticketId}/drafts`, {
    data: { regenerate: true },
  });
  expect(refused.status()).toBe(409);
  expect(await refused.json()).toEqual({ error: "ticket_closed" });
  const manual = await page.request.post(`/v1/tickets/${ticketId}/drafts`, {
    data: { body: "Glad you found the answer." },
  });
  expect(manual.status()).toBe(201);
  await page.reload();
  await expect(page.getByTestId("draft-body")).toHaveText("Glad you found the answer.");
});
