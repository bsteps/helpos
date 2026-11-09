import { expect, test } from "@playwright/test";
import { signIn, uniqueSubject } from "./support.ts";

test("an owner adds a Markdown source, sees it become ready, edits it and deletes it", async ({
  page,
}) => {
  const title = uniqueSubject("Warranty");
  await signIn(page);
  await page.getByRole("link", { name: "Knowledge" }).click();
  await expect(page.getByRole("heading", { name: "Knowledge", level: 1 })).toBeVisible();

  await page.getByRole("button", { name: "Add a source" }).click();
  await page.getByLabel("Title").fill(title);
  await page
    .getByLabel("Content")
    .fill("# Warranty\n\nEvery frame has a five year warranty against defects.");
  await page.getByRole("button", { name: "Add source", exact: true }).click();

  const card = page.getByTestId("knowledge-source").filter({ hasText: title });
  await expect(card.getByText("Ready", { exact: true })).toBeVisible();
  await expect(card).toContainText("Internal");
  await expect(card).toContainText("1 passage");

  await card.getByRole("button", { name: "Edit" }).click();
  await card.getByLabel("Visibility").selectOption("public");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card).toContainText("Public");

  await card.getByRole("button", { name: "Delete" }).click();
  await card.getByRole("button", { name: "Keep" }).click();
  await card.getByRole("button", { name: "Delete" }).click();
  await card.getByRole("button", { name: "Delete" }).click();
  await expect(card).toBeHidden();
  await page.reload();
  await expect(page.getByText(title)).toBeHidden();
});

test("a web page that can't be read says why, and can be read again", async ({ page }) => {
  const title = uniqueSubject("Local page");
  await signIn(page);
  await page.getByRole("link", { name: "Knowledge" }).click();

  await page.getByRole("button", { name: "Add a source" }).click();
  await page.getByRole("button", { name: "Web page" }).click();
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("URL").fill(`http://127.0.0.1/${crypto.randomUUID()}`);
  await page.getByRole("button", { name: "Add source", exact: true }).click();

  const card = page.getByTestId("knowledge-source").filter({ hasText: title });
  await expect(card.getByText("Failed", { exact: true })).toBeVisible();
  await expect(card).toContainText("This address is private or local");

  const reingested = page.waitForResponse((r) => r.url().endsWith("/reingest"));
  await card.getByRole("button", { name: "Read again" }).click();
  expect((await reingested).status()).toBe(202);
  await expect(card.getByText("Failed", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Read again" })).toBeEnabled();
});

test("someone without knowledge:write sees the sources but no edit controls", async ({ page }) => {
  await page.route("**/v1/me", async (route) => {
    const response = await route.fetch();
    const me = (await response.json()) as { scopes: string[] };
    await route.fulfill({
      response,
      json: { ...me, scopes: me.scopes.filter((s) => s !== "knowledge:write") },
    });
  });
  await signIn(page);
  const title = uniqueSubject("Read-only note");
  const added = await page.request.post("/v1/knowledge/sources", {
    data: { kind: "markdown", title, content: "Read-only test note." },
  });
  expect(added.status(), await added.text()).toBe(201);
  await page.getByRole("link", { name: "Knowledge" }).click();

  await expect(page.getByTestId("knowledge-source").filter({ hasText: title })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add a source" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Read again" })).toHaveCount(0);
});
