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

test("log in → open ticket → edit the AI draft → approve → the reply arrives", async ({
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

test("closing a ticket takes it out of the inbox", async ({ page, request }) => {
  const subject = uniqueSubject("Please close me");
  await deliver(request, plainEmail(subject, "All sorted, thanks."));

  await signIn(page);
  await page.getByRole("link", { name: subject }).click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByText("Closed", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close", exact: true })).toBeHidden();

  await page.getByRole("link", { name: "Inbox" }).first().click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(page.getByRole("link", { name: subject })).toBeHidden();
});

test("a signed-out visitor is sent to sign in, then back to the ticket", async ({
  page,
  request,
}) => {
  const subject = uniqueSubject("Deep link");
  const ticketId = await deliver(request, plainEmail(subject, "Opened from a notice email."));

  await page.goto(`/tickets/${ticketId}`);
  await expect(page).toHaveURL(/\/login\?redirect=/);
  await page.getByLabel("Email").fill(state().owner);
  await page.getByLabel("Password").fill("not the password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Wrong email or password.")).toBeVisible();

  await page.getByLabel("Password").fill(ownerPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(new RegExp(`/tickets/${ticketId}$`));
  await expect(page.getByRole("heading", { name: subject })).toBeVisible();
});

test("signing out ends the session", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
});
