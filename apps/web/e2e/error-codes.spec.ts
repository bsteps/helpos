import { expect, test } from "@playwright/test";
import { signIn, state } from "./support.ts";

test("typed API refusals keep contextual messages and external responses keep the fallback", async ({
  page,
}) => {
  await signIn(page);
  await page.getByRole("link", { name: "Settings" }).click();
  const before = await (await page.request.get("/v1/workspace/shadow-mode")).json();
  await page.getByRole("button", { name: "Turn off shadow mode" }).click();
  const refusal = page.waitForResponse(
    (response) =>
      response.url().endsWith("/v1/workspace/shadow-mode") &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Send replies to customers" }).click();
  const response = await refusal;
  expect(response.status()).toBe(409);
  expect(response.headers()["content-type"]).toBe("application/problem+json");
  expect(await response.json()).toMatchObject({
    error: "shadow_mode_locked",
    status: 409,
    type: "about:blank",
    instance: `urn:request:${response.headers()["x-request-id"]}`,
  });
  await expect(page.getByRole("alert")).toContainText("doesn't allow turning shadow mode off");
  expect(await (await page.request.get("/v1/workspace/shadow-mode")).json()).toEqual(before);

  await page.getByLabel("Repository").fill(state().githubRepo);
  await page.getByLabel("Personal access token").fill(`github_pat_${"invalid".repeat(8)}`);
  const rejected = page.waitForResponse(
    (response) =>
      response.url().endsWith("/v1/integrations/github") && response.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const github = await rejected;
  expect(github.status()).toBe(422);
  expect(await github.json()).toMatchObject({ error: "token_rejected", status: 422 });
  await expect(
    page.getByText(
      "GitHub didn't accept this token. Check it hasn't expired and has Issues read and write access to the repo.",
    ),
  ).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("known-errors.png") });

  await page.route("**/v1/integrations/github", (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({
          status: 502,
          contentType: "application/problem+json",
          json: { error: "external_proxy_error" },
        })
      : route.fallback(),
  );
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText("That didn't work. Try again.", { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("external-fallback.png") });
});
