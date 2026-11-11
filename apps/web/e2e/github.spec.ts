import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";
import { deliver, plainEmail, signIn, state, uniqueSubject, waitForMail } from "./support.ts";

// The product's wedge, through the dashboard at laptop and phone size: a conversation becomes a
// GitHub issue, GitHub says it's closed (a simulated, signed webhook), and the customer is told
// it's fixed, after a human approves it. GitHub is faked by the e2e server; shadow mode is on.

const sign = (secret: string, body: string) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

test("conversation → GitHub issue → closed on GitHub → approve the fix notice → the customer is told", async ({
  page,
  request,
}) => {
  const { githubRepo, githubToken, issueTitle, owner } = state();
  const subject = uniqueSubject("Export broken");
  await deliver(
    request,
    plainEmail(subject, "When I click Export CSV in Reports I get an error page. Please fix!"),
  );

  // An owner connects the repo. The token is checked with GitHub and never shown again.
  await signIn(page);
  const reset = await page.request.delete("/v1/integrations/github");
  expect(reset.status()).toBe(204);
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByText("Not connected", { exact: true })).toBeVisible();
  await page.getByLabel("Repository").fill(githubRepo);
  await page.getByLabel("Personal access token").fill(githubToken);
  // Exact: once connected, a "Disconnect" button is on the page too.
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText(`Connected to ${githubRepo}`)).toBeVisible();
  const webhookUrl = (await page.getByTestId("webhook-url").textContent()) ?? "";
  const firstSecret = (await page.getByTestId("webhook-secret").textContent()) ?? "";
  expect(webhookUrl).toContain("/v1/integrations/github/webhook?workspace=");
  expect(firstSecret).toMatch(/^[0-9a-f]{64}$/);

  // Say the secret leaked: the owner gets a new one without entering the token again.
  await page.getByRole("button", { name: "New webhook secret" }).click();
  await expect(page.getByText("New webhook secret. Paste it into GitHub now")).toBeVisible();
  const secret = (await page.getByTestId("webhook-secret").textContent()) ?? "";
  expect(secret).toMatch(/^[0-9a-f]{64}$/);
  expect(secret).not.toBe(firstSecret);
  expect(await page.content()).not.toContain(githubToken);
  const read = await page.request.get("/v1/integrations/github");
  expect(await read.text()).not.toContain(githubToken);

  // On the conversation, the AI suggests the issue; the human edits it, then confirms.
  await page.goto("/");
  await page.getByRole("link", { name: subject }).click();
  await expect(page.getByRole("heading", { name: subject })).toBeVisible();
  // Counts the AI calls: each one is paid from the workspace's daily budget.
  let drafts = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/github-issue/draft")) drafts++;
  });
  await page.getByRole("button", { name: "Create GitHub issue" }).click();
  const title = page.getByRole("textbox", { name: "Title" });
  await expect(title).toHaveValue(issueTitle);
  await expect(page.getByRole("textbox", { name: "Description" })).toHaveValue(
    /### Steps to reproduce\n1\. Open Reports/,
  );
  await title.fill("CSV export from Reports shows an error page");
  // Cancelled and opened again: the same suggestion, with the edit, and no second AI call.
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Create GitHub issue" }).click();
  await expect(title).toHaveValue("CSV export from Reports shows an error page");
  expect(drafts).toBe(1);
  await page.getByRole("button", { name: "Create issue" }).click();

  const issueLink = page.getByRole("link", { name: new RegExp(`^${githubRepo}#\\d+`) });
  await expect(issueLink).toBeVisible();
  await expect(page.getByText("Issue open")).toBeVisible();
  const number = Number((await issueLink.textContent())?.match(/#(\d+)/)?.[1]);
  expect(number).toBeGreaterThan(0);

  // GitHub closes the issue as completed. A forged delivery, or one signed with the old
  // secret, is refused first.
  const body = JSON.stringify({
    action: "closed",
    issue: { number, state: "closed", state_reason: "completed" },
    repository: { full_name: githubRepo },
  });
  const headers = { "content-type": "application/json", "x-github-event": "issues" };
  for (const wrong of ["not the secret", firstSecret]) {
    const forged = await request.post(webhookUrl, {
      headers: { ...headers, "x-hub-signature-256": sign(wrong, body) },
      data: body,
    });
    expect(forged.status()).toBe(401);
  }
  const delivered = await request.post(webhookUrl, {
    headers: { ...headers, "x-hub-signature-256": sign(secret, body) },
    data: body,
  });
  expect(delivered.status(), await delivered.text()).toBe(200);
  expect(await delivered.json()).toEqual({ status: "processed", conversations: 1 });

  // A fix notice waits for approval: nothing reached anyone yet.
  await page.reload();
  await expect(page.getByText("Issue closed")).toBeVisible();
  const notice = page.getByRole("region", { name: "Fix notice" });
  await expect(notice.getByText("has been fixed")).toBeVisible();
  await expect(notice.getByText("Waiting for approval")).toBeVisible();
  await notice.getByRole("button", { name: "Approve & send" }).click();
  await expect(notice.getByText("Sent", { exact: true })).toBeVisible({ timeout: 30_000 });

  // Shadow mode is on: the "fixed" email goes to the owner, never to the real customer.
  const mail = await waitForMail(request, `Re: ${subject}`);
  expect(mail.to).toEqual([owner]);
  expect(mail.text).toContain("has been fixed");
  expect(mail.text).toContain("NOT sent to the customer");
  expect(mail.text).toContain("jane@customer.test");

  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.getByText("Not connected", { exact: true })).toBeVisible();
  const disconnected = await page.request.get("/v1/integrations/github");
  expect(disconnected.status()).toBe(200);
  expect(await disconnected.json()).toMatchObject({ connected: false });
});
