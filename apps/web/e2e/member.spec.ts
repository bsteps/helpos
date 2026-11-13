import { expect, test } from "@playwright/test";
import { signIn, state } from "./support.ts";

test.beforeEach(async ({ page }) => {
  const { seedMember, seedPassword } = state();
  await signIn(page, { email: seedMember, password: seedPassword });
  const response = await page.request.get("/v1/me");
  expect(response.status()).toBe(200);
  const me = await response.json();
  expect(me.actor.type).toBe("user");
  expect(me.workspace.name).toBe("Northwind Cycles");
  expect(me.scopes).toContain("knowledge:write");
  expect(me.scopes).not.toContain("workspace:admin");
});

test("a member can't change owner-only settings, in the dashboard or the API", async ({ page }) => {
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toHaveCount(0);
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();

  for (const name of ["Shadow mode", "GitHub"]) {
    const card = page.locator('[data-slot="card"]').filter({
      has: page.getByRole("heading", { name, exact: true }),
    });
    await expect(card.getByText("Only workspace owners can change this.")).toBeVisible();
    await expect(card.getByRole("button")).toHaveCount(0);
    await expect(card.locator("input")).toHaveCount(0);
  }
  await expect(page.getByTestId("shadow-mode-summary")).toBeVisible();

  const shadowBefore = await page.request.get("/v1/workspace/shadow-mode");
  expect(shadowBefore.status()).toBe(200);
  const shadow = await shadowBefore.json();
  const refused = await page.request.patch("/v1/workspace/shadow-mode", {
    data: { recipient: "member-change@northwind-cycles.test" },
  });
  expect(refused.status()).toBe(403);
  expect(await refused.json()).toMatchObject({ error: "forbidden" });
  const shadowAfter = await page.request.get("/v1/workspace/shadow-mode");
  expect(shadowAfter.status()).toBe(200);
  expect(await shadowAfter.json()).toEqual(shadow);

  for (const { method, path } of [
    { method: "PUT", path: "/v1/integrations/github" },
    { method: "DELETE", path: "/v1/integrations/github" },
    { method: "POST", path: "/v1/integrations/github/webhook-secret" },
  ]) {
    const response = await page.request.fetch(path, { method });
    expect(response.status()).toBe(403);
    expect(await response.json()).toMatchObject({ error: "forbidden" });
  }
});
