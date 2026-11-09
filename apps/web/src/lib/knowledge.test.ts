import { describe, expect, it } from "vitest";
import type { KnowledgeSource } from "@/api/client.ts";
import { knowledgeErrorMessage, pollDelay } from "./knowledge.ts";

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
  it("looks again every 2 seconds while a source has just started being read", () => {
    expect(pollDelay([source("ready"), source("pending")], now)).toBe(2_000);
  });

  it("slows to every 30 seconds once a source has been pending for minutes", () => {
    expect(pollDelay([source("pending", null, secondsAgo(300))], now)).toBe(30_000);
  });

  it("treats a pending source with an unreadable time as just started", () => {
    expect(pollDelay([source("pending", null, "not a date")], now)).toBe(2_000);
  });

  it("stays slow for a stuck source once a newer one has finished", () => {
    const stuck = source("pending", null, secondsAgo(600));
    expect(pollDelay([stuck, source("ready", null, secondsAgo(1))], now)).toBe(30_000);
  });

  it("stops once every source is ready or failed", () => {
    expect(pollDelay([source("ready"), source("failed", "no_text")], now)).toBe(false);
  });

  it("stops for a source waiting hours for the daily AI budget", () => {
    expect(pollDelay([source("pending", "daily_budget_reached")], now)).toBe(false);
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
