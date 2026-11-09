import { describe, expect, it } from "vitest";
import type { KnowledgeSource } from "@/api/client.ts";
import {
  knowledgeErrorMessage,
  type ListedSource,
  pollDelay,
  withPendingSince,
} from "./knowledge.ts";

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
  const pendingFor = (seconds: number, error: string | null = null): ListedSource => ({
    ...source("pending", error),
    pendingSince: now - seconds * 1000,
  });

  it("looks again every 2 seconds while a source has just started being read", () => {
    expect(pollDelay([source("ready"), pendingFor(5)], now)).toBe(2_000);
  });

  it("slows to every 30 seconds once a source has been pending for minutes", () => {
    expect(pollDelay([pendingFor(300)], now)).toBe(30_000);
  });

  it("checks every 5 minutes on a source waiting for the daily AI budget", () => {
    expect(pollDelay([pendingFor(5, "daily_budget_reached")], now)).toBe(300_000);
  });

  it("stops once every source is ready or failed", () => {
    expect(pollDelay([source("ready"), source("failed", "no_text")], now)).toBe(false);
  });
});

describe("withPendingSince", () => {
  it("keeps the first time this browser saw a source pending, whatever the server clock says", () => {
    const pending = source("pending", null, new Date(now + 3_600_000).toISOString());
    const first = withPendingSince([pending], undefined, now);
    const later = withPendingSince([pending], first, now + 10_000);
    expect(later[0]?.pendingSince).toBe(now);
  });

  it("starts the clock when the server says it went pending", () => {
    const stuck = source("pending", null, secondsAgo(3600));
    expect(withPendingSince([stuck], undefined, now)[0]?.pendingSince).toBe(now - 3_600_000);
  });

  it("restarts the clock when the source was asked again between two looks", () => {
    const first = withPendingSince([source("pending", null, secondsAgo(300))], undefined, now);
    const again = { ...source("pending", null, secondsAgo(1)), id: first[0]?.id ?? "" };
    expect(withPendingSince([again], first, now)[0]?.pendingSince).toBe(now - 1000);
  });

  it("forgets the time once the source is done", () => {
    const first = withPendingSince([source("pending")], undefined, now);
    const done = { ...source("ready"), id: first[0]?.id ?? "" };
    expect(withPendingSince([done], first, now + 10_000)[0]?.pendingSince).toBeUndefined();
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
