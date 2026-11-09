import { describe, expect, it } from "vitest";
import type { KnowledgeSource } from "@/api/client.ts";
import { knowledgeErrorMessage, notePending, pollDelay } from "./knowledge.ts";

const now = Date.parse("2026-11-09T12:00:00Z");
const secondsAgo = (s: number) => new Date(now - s * 1000).toISOString();

function source(
  status: KnowledgeSource["status"],
  error: string | null = null,
  updatedAt = secondsAgo(5),
): KnowledgeSource {
  return {
    id: crypto.randomUUID(),
    slug: "s",
    kind: "markdown",
    title: "S",
    url: null,
    visibility: "internal",
    status,
    error,
    chunkCount: 0,
    managedBy: "app",
    sourcePath: null,
    embeddingModel: null,
    createdAt: "2026-11-09T00:00:00Z",
    updatedAt,
    ingestedAt: null,
  };
}

describe("pollDelay", () => {
  const seen = (entries: [KnowledgeSource, number][]) =>
    new Map(entries.map(([s, secondsBefore]) => [s.id, now - secondsBefore * 1000]));

  it("looks again every 2 seconds while a source has just started being read", () => {
    const reading = source("pending");
    expect(pollDelay([source("ready"), reading], now, seen([[reading, 5]]))).toBe(2_000);
  });

  it("slows to every 30 seconds once a source has been pending for minutes", () => {
    const stuck = source("pending");
    expect(pollDelay([stuck], now, seen([[stuck, 300]]))).toBe(30_000);
  });

  it("goes by when this browser saw it pending, not by the server's clock", () => {
    const stuck = source("pending", null, new Date(now + 3_600_000).toISOString());
    expect(pollDelay([stuck], now, seen([[stuck, 300]]))).toBe(30_000);
  });

  it("stops once every source is ready or failed", () => {
    expect(pollDelay([source("ready"), source("failed", "no_text")], now, new Map())).toBe(false);
  });

  it("stops for a source waiting hours for the daily AI budget", () => {
    expect(pollDelay([source("pending", "daily_budget_reached")], now, new Map())).toBe(false);
  });
});

describe("notePending", () => {
  it("keeps the first time a source was seen pending, and forgets it once it's done", () => {
    const since = new Map<string, number>();
    const s = source("pending");
    notePending(since, [s], now);
    notePending(since, [s], now + 10_000);
    expect(since.get(s.id)).toBe(now);
    notePending(since, [{ ...s, status: "ready" }], now + 20_000);
    expect(since.has(s.id)).toBe(false);
  });
});

describe("knowledgeErrorMessage", () => {
  it("names a missing page by its HTTP status", () => {
    expect(knowledgeErrorMessage("http_404")).toBe("The page wasn't found (HTTP 404).");
  });

  it("names any other HTTP failure by its status", () => {
    expect(knowledgeErrorMessage("http_503")).toBe("The site answered with an error (HTTP 503).");
  });

  it("says a page behind a sign-in can't be read", () => {
    expect(knowledgeErrorMessage("http_403")).toBe(
      "The page needs a sign-in, so it can't be read (HTTP 403).",
    );
  });

  it("keeps a code it doesn't know, so the owner can still report it", () => {
    expect(knowledgeErrorMessage("ingest_error")).toBe("Reading it failed (ingest_error).");
  });
});
