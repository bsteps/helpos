import { expect, test } from "@playwright/test";
import { deliver, ownerPassword, plainEmail, signIn, state, uniqueSubject } from "./support.ts";

test("expired session during approval returns to the same conversation after sign-in", async ({
  page,
  context,
  request,
}) => {
  const subject = uniqueSubject("Session recovery");
  const id = await deliver(request, plainEmail(subject, "Please help with my order."));
  const path = `/conversations/${id}`;
  await signIn(page);
  await page.goto(path);
  await expect(page.getByRole("heading", { name: subject })).toBeVisible();
  await expect(page.getByTestId("draft-body")).toHaveText(state().draft);
  const approve = page.getByRole("button", { name: "Approve & send", exact: true });
  await expect(approve).toBeEnabled();

  await context.clearCookies();
  const rejectedApproval = page.waitForResponse(
    (response) => response.url().endsWith("/approve") && response.request().method() === "POST",
  );
  await approve.click();
  expect((await rejectedApproval).status()).toBe(401);
  await expect(page).toHaveURL(
    (url) => url.pathname === "/login" && url.searchParams.get("redirect") === path,
  );
  await expect(page.getByRole("heading", { name: /Sign in to/ })).toBeVisible();
  await page.getByLabel("Email").fill(state().owner);
  await page.getByLabel("Password").fill(ownerPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(path);
  await expect(page.getByRole("heading", { name: subject })).toBeVisible();
  await expect(approve).toBeEnabled();
  const drafts = await page.request.get(`/v1/conversations/${id}/drafts`);
  expect(drafts.status()).toBe(200);
  expect(await drafts.json()).toMatchObject({
    drafts: [{ status: "pending", body: state().draft }],
  });
});

test("unknown and other-workspace conversations show the same not-found message", async ({
  page,
  request,
}) => {
  const subject = uniqueSubject("Private conversation");
  const body = "This customer's message belongs to the original workspace.";
  const foreignId = await deliver(request, plainEmail(subject, body));
  await signIn(page);
  const owned = await page.request.get(`/v1/conversations/${foreignId}`);
  expect(owned.status()).toBe(200);
  expect(await owned.json()).toMatchObject({ id: foreignId, subject });
  await signIn(page, { email: state().seedOwner, password: state().seedPassword });

  for (const id of [crypto.randomUUID(), foreignId]) {
    const response = page.waitForResponse(
      (result) => new URL(result.url()).pathname === `/v1/conversations/${id}`,
    );
    await page.goto(`/conversations/${id}`);
    expect((await response).status()).toBe(404);
    await expect(page.getByRole("alert")).toHaveText(
      "This conversation doesn't exist in your workspace. Back to the inbox",
    );
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByText(subject, { exact: true })).toBeHidden();
    await expect(page.getByText(body, { exact: true })).toBeHidden();
    await expect(page.getByRole("button", { name: "Approve & send" })).toBeHidden();
    await page.getByRole("link", { name: "Back to the inbox" }).click();
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  }
});

test("bare password link explains that the full link is required", async ({ page }) => {
  await page.goto("/set-password");
  await expect(page.getByRole("heading", { name: /Set your .+ password/ })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveText(
    "This page needs the full link you were sent. Open that link again.",
  );
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByLabel("New password")).toBeHidden();
  await expect(page.getByRole("button", { name: "Set password", exact: true })).toBeHidden();
});
