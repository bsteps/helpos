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

function source(state: KnowledgeSource["state"], updatedAt = secondsAgo(5)): KnowledgeSource {
  return {
    id: crypto.randomUUID(),
    slug: "s",
    kind: "markdown",
    title: "S",
    url: null,
    visibility: "internal",
    state,
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
  const pendingFor = (
    seconds: number,
    state: KnowledgeSource["state"] = { status: "pending" },
  ): ListedSource => ({
    ...source(state),
    pendingSince: now - seconds * 1000,
  });

  it("looks again every 2 seconds while a source has just started being read", () => {
    expect(pollDelay([source({ status: "ready" }), pendingFor(5)], now)).toBe(2_000);
  });

  it("slows to every 30 seconds once a source has been pending for minutes", () => {
    expect(pollDelay([pendingFor(300)], now)).toBe(30_000);
  });

  it("checks every minute when nothing is being read, so others' changes show up", () => {
    expect(
      pollDelay(
        [source({ status: "ready" }), source({ status: "failed", reason: { code: "no_text" } })],
        now,
      ),
    ).toBe(60_000);
  });

  it("checks a source waiting for the daily AI budget only every minute", () => {
    expect(
      pollDelay(
        [
          pendingFor(5, {
            status: "waiting",
            reason: { code: "daily_budget_reached" },
            retryAt: new Date(now + 86_400_000).toISOString(),
          }),
        ],
        now,
      ),
    ).toBe(60_000);
  });
});

describe("temporary waits", () => {
  it("keeps polling temporary failures at the pending cadence", () => {
    const waiting = source(
      {
        status: "waiting",
        reason: { code: "http_error", status: 503 },
        retryAt: new Date(now + 900_000).toISOString(),
      },
      secondsAgo(300),
    );
    const listed = withPendingSince([waiting], undefined, now);
    expect(pollDelay(listed, now)).toBe(30_000);
  });

  it("carries the pending clock into a wait", () => {
    const pending = source({ status: "pending" });
    const first = withPendingSince([pending], undefined, now);
    const waiting = {
      ...pending,
      state: {
        status: "waiting",
        reason: { code: "embedding_unavailable" },
        retryAt: new Date(now + 900_000).toISOString(),
      },
    } satisfies KnowledgeSource;
    expect(withPendingSince([waiting], first, now + 10_000)[0]?.pendingSince).toBe(
      first[0]?.pendingSince,
    );
  });
});

describe("withPendingSince", () => {
  it("keeps the first time this browser saw a source pending, whatever the server clock says", () => {
    const pending = source({ status: "pending" }, new Date(now + 3_600_000).toISOString());
    const first = withPendingSince([pending], undefined, now);
    const later = withPendingSince([pending], first, now + 10_000);
    expect(later[0]?.pendingSince).toBe(now);
  });

  it("starts the clock when the server says it went pending", () => {
    const stuck = source({ status: "pending" }, secondsAgo(3600));
    expect(withPendingSince([stuck], undefined, now)[0]?.pendingSince).toBe(now - 3_600_000);
  });

  it("restarts the clock when the source was asked again between two looks", () => {
    const first = withPendingSince(
      [source({ status: "pending" }, secondsAgo(300))],
      undefined,
      now,
    );
    const again = { ...source({ status: "pending" }, secondsAgo(1)), id: first[0]?.id ?? "" };
    expect(withPendingSince([again], first, now)[0]?.pendingSince).toBe(now - 1000);
  });

  it("forgets the time once the source is done", () => {
    const first = withPendingSince([source({ status: "pending" })], undefined, now);
    const done = { ...source({ status: "ready" }), id: first[0]?.id ?? "" };
    expect(withPendingSince([done], first, now + 10_000)[0]?.pendingSince).toBeUndefined();
  });
});

describe("knowledgeErrorMessage", () => {
  it("names a missing page by its HTTP status", () => {
    expect(knowledgeErrorMessage({ code: "http_error", status: 404 })).toBe(
      "The page wasn't found (HTTP 404).",
    );
  });

  it("names any other HTTP failure by its status", () => {
    expect(knowledgeErrorMessage({ code: "http_error", status: 503 })).toBe(
      "The site answered with an error (HTTP 503).",
    );
  });

  it("says a page behind a sign-in can't be read", () => {
    expect(knowledgeErrorMessage({ code: "http_error", status: 403 })).toBe(
      "The page needs a sign-in, so it can't be read (HTTP 403).",
    );
  });

  it("keeps a code it doesn't know, so the owner can still report it", () => {
    expect(knowledgeErrorMessage({ code: "ingest_error" })).toBe(
      "Reading it failed (ingest_error).",
    );
  });
});
