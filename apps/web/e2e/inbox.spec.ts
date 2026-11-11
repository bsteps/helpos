import { expect, test } from "@playwright/test";
import {
  deliver,
  ownerPassword,
  plainEmail,
  signIn,
  state,
  uniqueSubject,
  waitForMail,
} from "./support.ts";

// The demo loop through the dashboard, at laptop and phone size: an email arrives, the AI
// drafts a reply, a human edits and approves it, and it goes out.

test("log in → open conversation → edit the AI draft → approve → the reply arrives", async ({
  page,
  request,
}) => {
  const subject = uniqueSubject("Where is my order?");
  await deliver(request, plainEmail(subject, "Hi, my order #1234 hasn't arrived yet."));

  await signIn(page);
  await page.getByRole("link", { name: subject }).click();
  await expect(page.getByRole("heading", { name: subject })).toBeVisible();
  await expect(page.getByText("my order #1234 hasn't arrived yet")).toBeVisible();

  // The worker drafts it in the background; the page picks it up without a reload.
  const draft = page.getByTestId("draft-body");
  await expect(draft).toHaveText(state().draft);
  await expect(page.getByText("Waiting for approval")).toBeVisible();

  await page.getByRole("button", { name: "Edit" }).click();
  const edited = "Sorry for the wait! Your order ships today. Tracking follows by email.";
  await page.getByRole("textbox", { name: "Reply" }).fill(edited);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(draft).toHaveText(edited);

  await page.getByRole("button", { name: "Approve & send" }).click();
  await expect(page.getByText("Sent", { exact: true })).toBeVisible({ timeout: 30_000 });

  // Shadow mode is on: the reply goes to the owner, never to the real customer.
  const mail = await waitForMail(request, `Re: ${subject}`);
  expect(mail.to).toEqual([state().owner]);
  expect(mail.text).toContain(edited);
  expect(mail.text).not.toContain(state().draft);
});

test("closing a conversation takes it out of the inbox", async ({ page, request }) => {
  const subject = uniqueSubject("Please close me");
  await deliver(request, plainEmail(subject, "All sorted, thanks."));

  await signIn(page);
  await page.getByRole("link", { name: subject }).click();
  await page.getByRole("button", { name: "Close conversation" }).click();
  await expect(page.getByText("Closed", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close conversation" })).toBeHidden();

  await page.getByRole("link", { name: "Inbox" }).first().click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(page.getByRole("link", { name: subject })).toBeHidden();
});

test("a signed-out visitor is sent to sign in, then back to the conversation", async ({
  page,
  request,
}) => {
  const subject = uniqueSubject("Deep link");
  const conversationId = await deliver(request, plainEmail(subject, "Opened from a notice email."));

  // With a query string, as a link in a notice email might have: it must survive the detour.
  await page.goto(`/conversations/${conversationId}?from=notice`);
  await expect(page).toHaveURL(/\/login\?redirect=/);
  await page.getByLabel("Email").fill(state().owner);
  await page.getByLabel("Password").fill("not the password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Wrong email or password.")).toBeVisible();

  await page.getByLabel("Password").fill(ownerPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(new RegExp(`/conversations/${conversationId}\\?from=notice$`));
  await expect(page.getByRole("heading", { name: subject })).toBeVisible();
});

test("approving a draft someone changed meanwhile is refused, and says so", async ({
  page,
  request,
}) => {
  const subject = uniqueSubject("Changed meanwhile");
  const conversationId = await deliver(request, plainEmail(subject, "Can I change my address?"));

  await signIn(page);
  await page.goto(`/conversations/${conversationId}`);
  const draft = page.getByTestId("draft-body");
  await expect(draft).toHaveText(state().draft);

  // A teammate edits the draft elsewhere while this page still shows the old text.
  const list = await page.request.get(`/v1/conversations/${conversationId}/drafts`);
  const { drafts } = (await list.json()) as { drafts: { id: string }[] };
  const theirs = "Yes: reply with the new address and we'll update the order.";
  const edit = await page.request.patch(`/v1/drafts/${drafts[0]?.id}`, { data: { body: theirs } });
  expect(edit.ok(), await edit.text()).toBe(true);

  await page.getByRole("button", { name: "Approve & send" }).click();
  await expect(page.getByText("This draft changed since you opened it")).toBeVisible();
  // Their text is shown now, and nothing was sent.
  await expect(draft).toHaveText(theirs);
  await expect(page.getByText("Waiting for approval")).toBeVisible();
});

test("an HTML email's frame shrinks back when the window gets wider", async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name === "phone", "resizes the window, which a phone can't");
  const subject = uniqueSubject("Long HTML");
  const paragraph = `<p>${"This sentence wraps a lot on a narrow screen. ".repeat(20)}</p>`;
  await deliver(
    request,
    [
      "From: Jane Customer <jane@customer.test>",
      `To: ${state().mailbox}`,
      `Subject: ${subject}`,
      `Message-ID: <${crypto.randomUUID()}@customer.test>`,
      "Content-Type: text/html; charset=utf-8",
      "",
      paragraph.repeat(3),
    ].join("\n"),
  );

  await signIn(page);
  await page.getByRole("link", { name: subject }).click();
  const frame = page.locator('iframe[title="Email from jane@customer.test"]');
  const height = async () => (await frame.boundingBox())?.height ?? 0;

  await page.setViewportSize({ width: 360, height: 800 });
  await expect.poll(height).toBeGreaterThan(900);
  const narrow = await height();
  await page.setViewportSize({ width: 1366, height: 800 });
  await expect.poll(height).toBeLessThan(narrow * 0.7);
});

test("signing out ends the session", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
});
