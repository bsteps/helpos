import { expect, test } from "@playwright/test";
import type { KnowledgeSource } from "../src/api/client.ts";
import { deliver, plainEmail, signIn, uniqueSubject } from "./support.ts";

const cases = [
  { title: "Script source", url: "javascript:alert(1)", href: null },
  { title: "Data source", url: "data:text/html,hello", href: null },
  { title: "Missing host", url: "http://", href: null },
  {
    title: "Uppercase source",
    url: "HTTPS://EXAMPLE.COM/upper",
    href: "https://example.com/upper",
  },
  { title: "Spaced source", url: " https://example.com/space", href: "https://example.com/space" },
  { title: "Normal source", url: "https://example.com/normal", href: "https://example.com/normal" },
];

test("knowledge and citations render only parsed web links", async ({ page, request }) => {
  await signIn(page);
  await page.route("**/v1/knowledge/sources", (route) =>
    route.fulfill({
      json: {
        sources: cases.map(
          ({ title, url }) =>
            ({
              id: crypto.randomUUID(),
              title,
              url,
              kind: "url",
              visibility: "public",
              state: { status: "ready" },
              slug: title.toLowerCase().replaceAll(" ", "-"),
              sourcePath: null,
              embeddingModel: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              ingestedAt: new Date().toISOString(),
              chunkCount: 1,
              managedBy: "app",
            }) satisfies KnowledgeSource,
        ),
      },
    }),
  );
  await page.goto("/knowledge");
  for (const entry of cases) {
    const card = page.getByTestId("knowledge-source").filter({ hasText: entry.title });
    await expect(card).toBeVisible();
    if (entry.href) await expect(card.getByRole("link")).toHaveAttribute("href", entry.href);
    else await expect(card.locator("a")).toHaveCount(0);
  }

  const id = await deliver(request, plainEmail(uniqueSubject("Web links"), "Please help."));
  await page.route(`**/v1/conversations/${id}/drafts`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: {
        ...body,
        drafts: body.drafts.map((draft: object) => ({
          ...draft,
          sources: cases.map(({ title, url }) => ({
            sourceId: crypto.randomUUID(),
            title,
            url,
            excerpt: title,
            visibility: "public",
            cited: true,
          })),
        })),
      },
    });
  });
  await page.goto(`/conversations/${id}`);
  await expect(page.getByText("Written from")).toBeVisible();
  for (const entry of cases) {
    const item = page.getByRole("listitem").filter({ hasText: entry.title });
    await expect(item).toBeVisible();
    if (entry.href) {
      await expect(item.getByRole("link")).toHaveAttribute("href", entry.href);
      await expect(item.getByRole("link")).toHaveAttribute("rel", "noopener noreferrer");
    } else {
      await expect(item.locator("a")).toHaveCount(0);
    }
  }
});

test("GitHub issue links reject dangerous schemes", async ({ page, request }) => {
  await signIn(page);
  const id = await deliver(request, plainEmail(uniqueSubject("Issue link"), "Please help."));
  let url = "javascript:alert(1)";
  await page.route(`**/v1/conversations/${id}`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: {
        ...body,
        githubIssue: { repo: "acme/app", number: 234, url, state: "open" },
      },
    });
  });
  await page.goto(`/conversations/${id}`);
  await expect(page.getByText("acme/app#234", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "acme/app#234" })).toHaveCount(0);
  url = "HTTPS://GITHUB.COM/acme/app/issues/234";
  await page.reload();
  await expect(page.getByRole("link", { name: "acme/app#234" })).toHaveAttribute(
    "href",
    "https://github.com/acme/app/issues/234",
  );
});
