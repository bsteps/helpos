import type { KnowledgeSource } from "@/api/client.ts";

const fastPollMs = 2_000;
const slowPollMs = 30_000;
const budgetPollMs = 5 * 60_000;
const slowAfterMs = 2 * 60_000;

/** A source as the list shows it: when this browser first saw it pending, if it is. */
export type ListedSource = KnowledgeSource & { pendingSince?: number };

/**
 * Carries each pending source's first-seen time over from the previous list, as long as it is
 * the same stretch of pending: a new `updatedAt` means it was asked again, so the clock
 * restarts. Times come from this browser's clock, so a skewed server clock can't change pace.
 */
export function withPendingSince(
  sources: readonly KnowledgeSource[],
  previous: readonly ListedSource[] | undefined,
  now: number,
): ListedSource[] {
  const seen = new Map(previous?.map((s) => [s.id, s]));
  return sources.map((s) => {
    if (s.status !== "pending") return s;
    const before = seen.get(s.id);
    const same = before?.status === "pending" && before.updatedAt === s.updatedAt;
    return { ...s, pendingSince: same ? (before.pendingSince ?? now) : now };
  });
}

/**
 * How soon to look again: every 2 seconds while a source has just started being read, every
 * 30 seconds once one has been pending for minutes, and every 5 minutes for a source waiting
 * for the daily AI budget, which resets at midnight UTC.
 */
export function pollDelay(sources: readonly ListedSource[], now: number): number | false {
  const pending = sources.filter((s) => s.status === "pending");
  if (pending.length === 0) return false;
  const reading = pending.filter((s) => s.error !== "daily_budget_reached");
  if (reading.length === 0) return budgetPollMs;
  const fresh = reading.some((s) => now - (s.pendingSince ?? now) < slowAfterMs);
  return fresh ? fastPollMs : slowPollMs;
}

const aiUnavailable = "The AI service couldn't process it. It tries again by itself.";

const messages: Record<string, string> = {
  blocked_address: "This address is private or local, so it isn't fetched.",
  no_url: "This source has no address to fetch.",
  timeout: "The site took too long to answer.",
  network: "Couldn't reach the site.",
  no_text: "The page has no text to use.",
  too_large: "The page is too large to fetch.",
  too_long: "It's too long for one source. Split it into smaller ones.",
  unsupported_content_type: "This address isn't a web page or text.",
  embedding_unavailable: aiUnavailable,
  embedding_failed: aiUnavailable,
  daily_budget_reached: "Waiting for today's AI budget to reset at midnight UTC.",
};

export function knowledgeErrorMessage(code: string): string {
  const known = messages[code];
  if (known) return known;
  const status = /^http_(\d{3})$/.exec(code)?.[1];
  if (status === "404" || status === "410") return `The page wasn't found (HTTP ${status}).`;
  if (status === "401" || status === "403") {
    return `The page needs a sign-in, so it can't be read (HTTP ${status}).`;
  }
  if (status === "429")
    return "The site is limiting requests (HTTP 429). It tries again by itself.";
  if (status) return `The site answered with an error (HTTP ${status}).`;
  return `Reading it failed (${code}).`;
}
