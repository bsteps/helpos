import type { KnowledgeSource } from "@/api/client.ts";

const fastPollMs = 2_000;
const slowPollMs = 30_000;
const idlePollMs = 60_000;
const slowAfterMs = 2 * 60_000;

/** A source as the list shows it: when this browser first saw it pending, if it is. */
export type ListedSource = KnowledgeSource & { pendingSince?: number };

/**
 * When each pending source started its current stretch of pending: the server's `updatedAt`,
 * but never later than now, so a server clock running ahead can't keep a stuck source on fast
 * polling. A source first seen long after it got stuck starts slow. The time carries over
 * between lists until `updatedAt` changes, which means it was asked again.
 */
export function withPendingSince(
  sources: readonly KnowledgeSource[],
  previous: readonly ListedSource[] | undefined,
  now: number,
): ListedSource[] {
  const seen = new Map(previous?.map((s) => [s.id, s]));
  return sources.map((s) => {
    if (s.state.status !== "pending" && s.state.status !== "waiting") return s;
    const before = seen.get(s.id);
    const same =
      (before?.state.status === "pending" || before?.state.status === "waiting") &&
      before.updatedAt === s.updatedAt;
    const started = Math.min(now, Date.parse(s.updatedAt) || now);
    return { ...s, pendingSince: same ? (before.pendingSince ?? started) : started };
  });
}

/**
 * How soon to look again: every 2 seconds while a source has just started being read, every
 * 30 seconds once one has been pending for minutes, and otherwise every minute, so sources
 * that agents or other people add or change show up. React Query pauses it in a hidden tab.
 */
export function pollDelay(sources: readonly ListedSource[], now: number): number {
  const reading = sources.filter(
    (s) =>
      s.state.status === "pending" ||
      (s.state.status === "waiting" && s.state.reason.code !== "daily_budget_reached"),
  );
  if (reading.length === 0) return idlePollMs;
  const fresh = reading.some((s) => now - (s.pendingSince ?? now) < slowAfterMs);
  return fresh ? fastPollMs : slowPollMs;
}

const aiUnavailable = "The AI service couldn't process it. It tries again by itself.";

type KnowledgeReason = Extract<KnowledgeSource["state"], { reason: unknown }>["reason"];

const messages = new Map<KnowledgeReason["code"], string>([
  ["blocked_address", "This address is private or local, so it isn't fetched."],
  ["no_url", "This source has no address to fetch."],
  ["timeout", "The site took too long to answer."],
  ["network", "Couldn't reach the site."],
  ["no_text", "The page has no text to use."],
  ["too_large", "The page is too large to fetch."],
  ["too_long", "It's too long for one source. Split it into smaller ones."],
  ["unsupported_content_type", "This address isn't a web page or text."],
  ["embedding_unavailable", aiUnavailable],
  ["embedding_failed", aiUnavailable],
  ["daily_budget_reached", "Waiting for today's AI budget to reset at midnight UTC."],
]);

export function knowledgeErrorMessage(reason: KnowledgeReason): string {
  const known = messages.get(reason.code);
  if (known) return known;
  if (reason.code === "http_error") {
    const { status } = reason;
    if (status === 404 || status === 410) return `The page wasn't found (HTTP ${status}).`;
    if (status === 401 || status === 403) {
      return `The page needs a sign-in, so it can't be read (HTTP ${status}).`;
    }
    if (status === 429)
      return "The site is limiting requests (HTTP 429). It tries again by itself.";
    return `The site answered with an error (HTTP ${status}).`;
  }
  return `Reading it failed (${reason.code}).`;
}
