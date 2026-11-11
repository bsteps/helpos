import { expect, test } from "@playwright/test";
import { deliver, plainEmail, signIn, state, uniqueSubject } from "./support.ts";

const creationFailures = [
  { error: "github_outcome_unknown", status: 502, headline: "Check GitHub" },
  { error: "issue_not_linked", status: 500, headline: "Check GitHub" },
  { error: "issue_rejected", status: 502, headline: "No issue was created" },
];

for (const { error, status, headline } of creationFailures) {
  test(`${error} tells the owner ${headline}`, async ({ page, request }) => {
    const subject = uniqueSubject(error);
    await deliver(request, plainEmail(subject, "Export fails with an error."));
    await signIn(page);
    const connected = await page.request.put("/v1/integrations/github", {
      data: { repo: state().githubRepo, token: state().githubToken },
    });
    expect(connected.ok(), await connected.text()).toBeTruthy();
    await page.route("**/github-issue", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status, json: { error } })
        : route.fallback(),
    );
    await page.getByRole("link", { name: subject }).click();
    await page.getByRole("button", { name: "Create GitHub issue" }).click();
    await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue(state().issueTitle);
    await page.getByRole("button", { name: "Create issue", exact: true }).click();
    const alert = page.getByRole("alert");
    await expect(alert.getByText(headline, { exact: true })).toBeVisible();
    await expect(
      alert.getByText(headline === "Check GitHub" ? "No issue was created" : "Check GitHub", {
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue(state().issueTitle);
  });
}

test("a failed AI suggestion opens an empty form the owner can fill", async ({ page, request }) => {
  const subject = uniqueSubject("No suggestion");
  await deliver(request, plainEmail(subject, "Export fails with an error."));
  await signIn(page);
  const connected = await page.request.put("/v1/integrations/github", {
    data: { repo: state().githubRepo, token: state().githubToken },
  });
  expect(connected.ok(), await connected.text()).toBeTruthy();
  await page.route("**/github-issue/draft", (route) =>
    route.fulfill({ status: 502, json: { error: "ai_unavailable" } }),
  );
  await page.getByRole("link", { name: subject }).click();
  await page.getByRole("button", { name: "Create GitHub issue" }).click();
  await expect(page.getByRole("alert")).toContainText("The AI couldn't draft this issue.");
  const title = page.getByRole("textbox", { name: "Title" });
  const description = page.getByRole("textbox", { name: "Description" });
  await expect(title).toHaveValue("");
  await expect(description).toHaveValue("");
  await expect(page.getByRole("button", { name: "Create issue", exact: true })).toBeDisabled();
  await title.fill("Export fails");
  await description.fill("Click Export to reproduce the error.");
  await expect(page.getByRole("button", { name: "Create issue", exact: true })).toBeEnabled();
});

test("a classic token is refused before any connect request", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Settings" }).click();
  const requests: string[] = [];
  await page.route("**/v1/integrations/github", async (route) => {
    if (route.request().method() === "PUT") {
      requests.push(route.request().method());
      await route.fulfill({ status: 400, json: { error: "classic_token" } });
    } else {
      await route.fallback();
    }
  });
  await page.getByLabel("Repository").fill(state().githubRepo);
  const token = page.getByLabel("Personal access token");
  await token.fill("ghp_invalid_classic_test_token");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(token).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText(/Use a fine-grained token/)).toBeVisible();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  expect(requests).toEqual([]);
});

test("disconnect shows Not connected and persists after reload", async ({ page }) => {
  await signIn(page);
  const connected = await page.request.put("/v1/integrations/github", {
    data: { repo: state().githubRepo, token: state().githubToken },
  });
  expect(connected.ok(), await connected.text()).toBeTruthy();
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.getByText("Not connected", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Disconnect", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Not connected", { exact: true })).toBeVisible();
});
