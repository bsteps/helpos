import { expect, test } from "@playwright/test";
import { signIn } from "./support.ts";

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

  await page.screenshot({ path: test.info().outputPath("known-errors.png") });

  await page.route("**/v1/workspace/shadow-mode", (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({
          status: 502,
          contentType: "application/problem+json",
          json: { error: "external_proxy_error" },
        })
      : route.fallback(),
  );
  await page.getByRole("button", { name: "Turn off shadow mode" }).click();
  await page.getByRole("button", { name: "Send replies to customers" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "That didn't work. Nothing changed; try again.",
  );
  await page.screenshot({ path: test.info().outputPath("external-fallback.png") });
});
