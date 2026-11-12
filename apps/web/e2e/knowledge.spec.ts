import { expect, test } from "@playwright/test";
import type { KnowledgeSource } from "../src/api/client.ts";
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
  await test.info().attach("knowledge-ready", {
    body: await page.screenshot(),
    contentType: "image/png",
  });

  await card.getByRole("button", { name: "Edit" }).click();
  await expect(card.getByRole("button", { name: "Save" })).toBeDisabled();
  await card.getByLabel("Visibility").selectOption("public");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card).toContainText("Public");

  await card.getByRole("button", { name: "Delete" }).click();
  await card.getByRole("button", { name: "Keep" }).click();
  await card.getByRole("button", { name: "Delete" }).click();
  await card.getByRole("button", { name: "Delete" }).click();
  await expect(card).toBeHidden();
  const res = await page.request.get("/v1/knowledge/sources");
  const { sources } = (await res.json()) as { sources: { title: string }[] };
  expect(sources.map((s) => s.title)).not.toContain(title);
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

  const stored = async () => {
    const res = await page.request.get("/v1/knowledge/sources");
    const { sources } = (await res.json()) as {
      sources: KnowledgeSource[];
    };
    const found = sources.find((s) => s.title === title);
    if (!found) throw new Error(`no source titled ${title}`);
    return found;
  };
  const before = await stored();

  await card.getByRole("button", { name: "Read again" }).click();
  await expect
    .poll(async () => {
      const now = await stored();
      return now.updatedAt !== before.updatedAt && now.state.status === "failed";
    })
    .toBe(true);
  await expect(card.getByText("Failed", { exact: true })).toBeVisible();
  await expect(card).toContainText("This address is private or local");
});

test("a delete that fails says so, and the message goes once the owner keeps the source", async ({
  page,
}) => {
  const title = uniqueSubject("Delete fails");
  await signIn(page);
  const added = await page.request.post("/v1/knowledge/sources", {
    data: { kind: "markdown", title, content: "A note whose delete fails." },
  });
  expect(added.status(), await added.text()).toBe(201);
  await page.route("**/v1/knowledge/sources/*", (route) =>
    route.request().method() === "DELETE"
      ? route.fulfill({ status: 500, json: { error: "internal" } })
      : route.fallback(),
  );
  await page.getByRole("link", { name: "Knowledge" }).click();

  const card = page.getByTestId("knowledge-source").filter({ hasText: title });
  await card.getByRole("button", { name: "Delete" }).click();
  await card.getByRole("button", { name: "Delete" }).click();
  await expect(card.getByText("Couldn't delete it. Try again.")).toBeVisible();

  await card.getByRole("button", { name: "Keep" }).click();
  await expect(card.getByText("Couldn't delete it. Try again.")).toBeHidden();
  await expect(card.getByRole("button", { name: "Edit" })).toBeVisible();
});

test("router redirect only: without knowledge:read, Knowledge sends you to the inbox", async ({
  page,
}) => {
  await page.route("**/v1/me", async (route) => {
    const response = await route.fetch();
    const me = (await response.json()) as { scopes: string[] };
    await route.fulfill({
      response,
      json: { ...me, scopes: me.scopes.filter((s) => !s.startsWith("knowledge:")) },
    });
  });
  await signIn(page);
  await expect(page.getByRole("link", { name: "Knowledge" })).toHaveCount(0);

  await page.goto("/knowledge");
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(page).not.toHaveURL(/\/knowledge$/);
});

test("when the sources fail to load, Try again loads them", async ({ page }) => {
  await signIn(page);
  let failing = true;
  await page.route("**/v1/knowledge/sources", (route) =>
    failing && route.request().method() === "GET"
      ? route.fulfill({ status: 500, json: { error: "internal" } })
      : route.fallback(),
  );
  await page.getByRole("link", { name: "Knowledge" }).click();
  await expect(page.getByText("Couldn't load the knowledge sources.")).toBeVisible();

  failing = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Couldn't load the knowledge sources.")).toBeHidden();
  await expect(page.getByRole("list", { name: "Knowledge sources" })).toBeVisible();
});

test("a source managed in git is read-only and says where to change it", async ({ page }) => {
  const title = uniqueSubject("Git note");
  await signIn(page);
  await page.route("**/v1/knowledge/sources", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const { sources } = (await response.json()) as { sources: unknown[] };
    const fromGit = {
      id: crypto.randomUUID(),
      slug: "git-note",
      kind: "markdown",
      title,
      url: null,
      visibility: "public",
      state: { status: "ready" },
      chunkCount: 1,
      managedBy: "git",
      sourcePath: "knowledge/git-note.md",
      embeddingModel: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ingestedAt: new Date().toISOString(),
    };
    await route.fulfill({ response, json: { sources: [...sources, fromGit] } });
  });
  await page.getByRole("link", { name: "Knowledge" }).click();

  const card = page.getByTestId("knowledge-source").filter({ hasText: title });
  await expect(card).toContainText("knowledge/git-note.md");
  await expect(card).toContainText("edit its file in the workspace's git repo");
  await expect(card.getByRole("button")).toHaveCount(0);
});

test("a save the API refuses says why instead of asking to try again", async ({ page }) => {
  const title = uniqueSubject("Moved to git");
  await signIn(page);
  const added = await page.request.post("/v1/knowledge/sources", {
    data: { kind: "markdown", title, content: "A note that moves to git." },
  });
  expect(added.status(), await added.text()).toBe(201);
  await page.route("**/v1/knowledge/sources/*", (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({ status: 409, json: { error: "managed_in_git" } })
      : route.fallback(),
  );
  await page.getByRole("link", { name: "Knowledge" }).click();

  const card = page.getByTestId("knowledge-source").filter({ hasText: title });
  await card.getByRole("button", { name: "Edit" }).click();
  await card.getByLabel("Visibility").selectOption("public");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card).toContainText(
    "Couldn't save. Nothing changed. It's managed in the workspace's git repo now.",
  );
});

test("while a source is being added, its kind can't be switched", async ({ page }) => {
  await signIn(page);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/v1/knowledge/sources", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await held;
    await route.fallback();
  });
  await page.getByRole("link", { name: "Knowledge" }).click();
  await page.getByRole("button", { name: "Add a source" }).click();
  await page.getByLabel("Title").fill(uniqueSubject("Held add"));
  await page.getByLabel("Content").fill("Sent once.");
  await page.getByRole("button", { name: "Add source", exact: true }).click();

  await expect(page.getByRole("button", { name: "Web page" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Markdown" })).toBeDisabled();
  release();
  await expect(page.getByRole("button", { name: "Add a source" })).toBeVisible();
});

test("typed waiting reasons remain visible and disable Read again", async ({ page }) => {
  await signIn(page);
  const title = uniqueSubject("Waiting source");
  const added = await page.request.post("/v1/knowledge/sources", {
    data: { kind: "url", title, url: `http://127.0.0.1/${crypto.randomUUID()}` },
  });
  expect(added.status(), await added.text()).toBe(201);
  const source = (await added.json()) as KnowledgeSource;
  let state: KnowledgeSource["state"] = {
    status: "waiting",
    reason: { code: "daily_budget_reached" },
    retryAt: "2099-01-01T00:00:00.000Z",
  };
  await page.route("**/v1/knowledge/sources", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { sources: [{ ...source, state }] } })
      : route.fallback(),
  );
  await page.getByRole("link", { name: "Knowledge" }).click();
  const card = page.getByTestId("knowledge-source").filter({ hasText: title });
  await expect(card).toContainText("Waiting for today's AI budget to reset at midnight UTC.");
  await expect(card.getByRole("button", { name: "Read again" })).toBeDisabled();
  state = {
    status: "waiting",
    reason: { code: "http_error", status: 503 },
    retryAt: "2099-01-01T00:00:00.000Z",
  };
  await page.reload();
  await expect(card).toContainText("The site answered with an error (HTTP 503).");
  await expect(card.getByRole("button", { name: "Read again" })).toBeDisabled();
  state = { status: "failed", reason: { code: "http_error", status: 404 } };
  await page.reload();
  await expect(card.getByText("Failed", { exact: true })).toBeVisible();
  await expect(card).toContainText("The page wasn't found (HTTP 404).");
  await expect(card.getByRole("button", { name: "Read again" })).toBeEnabled();
});
