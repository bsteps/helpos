import { describe, expect, it } from "vitest";
import type { KnowledgeSource } from "@/api/client.ts";
import { knowledgeErrorMessage, stillReading } from "./knowledge.ts";

function source(status: KnowledgeSource["status"], error: string | null = null): KnowledgeSource {
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
    updatedAt: "2026-11-09T00:00:00Z",
    ingestedAt: null,
  };
}

describe("stillReading", () => {
  it("is true while a source is being read", () => {
    expect(stillReading([source("ready"), source("pending")])).toBe(true);
  });

  it("is false once every source is ready or failed", () => {
    expect(stillReading([source("ready"), source("failed", "no_text")])).toBe(false);
  });

  it("ignores a source waiting hours for the daily AI budget", () => {
    expect(stillReading([source("pending", "daily_budget_reached")])).toBe(false);
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
