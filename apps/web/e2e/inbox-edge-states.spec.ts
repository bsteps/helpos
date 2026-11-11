import { expect, test } from "@playwright/test";
import { deliver, plainEmail, signIn, state, uniqueSubject } from "./support.ts";

test("automated email has a badge and no draft panel", async ({ page, request }) => {
  const subject = uniqueSubject("Automated receipt");
  const body = "Your scheduled report is ready.";
  const id = await deliver(request, `Auto-Submitted: auto-generated\n${plainEmail(subject, body)}`);
  await signIn(page);
  const row = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: subject }) });
  await expect(row.getByText("Automated", { exact: true })).toBeVisible();
  await row.getByRole("link", { name: subject }).click();
  await expect(page.getByRole("heading", { name: subject })).toBeVisible();
  await expect(page.getByText(body, { exact: true })).toBeVisible();

  const control = await deliver(
    request,
    plainEmail(uniqueSubject("Human question"), "Can you help?"),
  );
  await expect
    .poll(async () => {
      const response = await page.request.get(`/v1/conversations/${control}/drafts`);
      expect(response.ok()).toBe(true);
      return (await response.json()).drafts;
    })
    .toMatchObject([{ status: "pending" }]);
  const drafts = await page.request.get(`/v1/conversations/${id}/drafts`);
  expect(drafts.ok()).toBe(true);
  expect(await drafts.json()).toMatchObject({ drafts: [] });
  await page.reload();
  await expect(page.getByText(body, { exact: true })).toBeVisible();
  await expect(page.getByTestId("draft-body")).toBeHidden();
  await expect(page.getByText("The AI is writing a draft…", { exact: true })).toBeHidden();
  await expect(
    page.getByRole("button", { name: /Approve & send|Ask AI|Write my own/ }),
  ).toBeHidden();
});

test("empty subject has a fallback in the inbox and conversation", async ({ page, request }) => {
  const body = uniqueSubject("A question without a subject");
  const id = await deliver(request, plainEmail("", body));
  await signIn(page);
  const link = page.locator(`a[href="/conversations/${id}"]`);
  await expect(link).toHaveText("(no subject)");
  await link.click();
  await expect(page.getByRole("heading", { name: "(no subject)", exact: true })).toBeVisible();
  await expect(page.getByText(body, { exact: true })).toBeVisible();
  await expect(page.getByTestId("draft-body")).toHaveText(state().draft);
});

test("empty inbox explains where new emails appear", async ({ page }) => {
  await page.route("**/v1/conversations?*", (route) =>
    route.fulfill({ json: { conversations: [] } }),
  );
  await signIn(page);
  await expect(page.getByText("Nothing open", { exact: true })).toBeVisible();
  await expect(page.getByText("New emails show up here.", { exact: true })).toBeVisible();
  await expect(page.getByText("0 open", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toBeHidden();
});

test("failed inbox load explains how to recover", async ({ page, request }) => {
  const subject = uniqueSubject("Recovery check");
  await deliver(request, plainEmail(subject, "Please help."));
  await page.route("**/v1/conversations?*", (route) =>
    route.fulfill({ status: 503, json: { error: "unavailable" } }),
  );
  await signIn(page);
  await expect(page.getByRole("alert")).toHaveText(
    "Couldn't load the inbox. Reload the page to try again.",
  );
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByText("Nothing open", { exact: true })).toBeHidden();
  await page.unroute("**/v1/conversations?*");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(page.getByRole("link", { name: subject })).toBeVisible();
  await expect(page.getByRole("alert")).toBeHidden();
});
