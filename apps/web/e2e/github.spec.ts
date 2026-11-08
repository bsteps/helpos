import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";
import { deliver, plainEmail, signIn, state, uniqueSubject, waitForMail } from "./support.ts";

// The product's wedge, through the dashboard at laptop and phone size: a ticket becomes a
// GitHub issue, GitHub says it's closed (a simulated, signed webhook), and the customer is told
// it's fixed, after a human approves it. GitHub is faked by the e2e server; shadow mode is on.

const sign = (secret: string, body: string) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

test("ticket → GitHub issue → closed on GitHub → approve the fix notice → the customer is told", async ({
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
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByLabel("Repository").fill(githubRepo);
  await page.getByLabel("Personal access token").fill(githubToken);
  // Exact: once connected, a "Disconnect" button is on the page too.
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText(`Connected to ${githubRepo}`)).toBeVisible();
  const webhookUrl = (await page.getByTestId("webhook-url").textContent()) ?? "";
  const secret = (await page.getByTestId("webhook-secret").textContent()) ?? "";
  expect(webhookUrl).toContain("/v1/integrations/github/webhook?workspace=");
  expect(secret).toMatch(/^[0-9a-f]{64}$/);
  expect(await page.content()).not.toContain(githubToken);
  const read = await page.request.get("/v1/integrations/github");
  expect(await read.text()).not.toContain(githubToken);

  // On the ticket, the AI suggests the issue; the human edits it, then confirms.
  await page.goto("/");
  await page.getByRole("link", { name: subject }).click();
  await expect(page.getByRole("heading", { name: subject })).toBeVisible();
  await page.getByRole("button", { name: "Create GitHub issue" }).click();
  const title = page.getByRole("textbox", { name: "Title" });
  await expect(title).toHaveValue(issueTitle);
  await expect(page.getByRole("textbox", { name: "Description" })).toHaveValue(
    /### Steps to reproduce\n1\. Open Reports/,
  );
  await title.fill("CSV export from Reports shows an error page");
  await page.getByRole("button", { name: "Create issue" }).click();

  const issueLink = page.getByRole("link", { name: new RegExp(`^${githubRepo}#\\d+`) });
  await expect(issueLink).toBeVisible();
  await expect(page.getByText("Issue open")).toBeVisible();
  const number = Number((await issueLink.textContent())?.match(/#(\d+)/)?.[1]);
  expect(number).toBeGreaterThan(0);

  // GitHub closes the issue as completed. A forged delivery is refused first.
  const body = JSON.stringify({
    action: "closed",
    issue: { number, state: "closed", state_reason: "completed" },
    repository: { full_name: githubRepo },
  });
  const headers = { "content-type": "application/json", "x-github-event": "issues" };
  const forged = await request.post(webhookUrl, {
    headers: { ...headers, "x-hub-signature-256": sign("not the secret", body) },
    data: body,
  });
  expect(forged.status()).toBe(401);
  const delivered = await request.post(webhookUrl, {
    headers: { ...headers, "x-hub-signature-256": sign(secret, body) },
    data: body,
  });
  expect(delivered.status(), await delivered.text()).toBe(200);
  expect(await delivered.json()).toEqual({ status: "processed", tickets: 1 });

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
});
