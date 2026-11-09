import type { KnowledgeSource } from "@/api/client.ts";

const fastPollMs = 2_000;
const slowPollMs = 30_000;
const slowAfterMs = 2 * 60_000;

const beingRead = (s: KnowledgeSource) =>
  s.status === "pending" && s.error !== "daily_budget_reached";

/**
 * Records when this browser first saw each source being read. Times come from this clock, not
 * the server's, so a skewed server clock can't keep a stuck source on fast polling.
 */
export function notePending(
  since: Map<string, number>,
  sources: readonly KnowledgeSource[],
  now: number,
): void {
  const reading = new Set(sources.filter(beingRead).map((s) => s.id));
  for (const id of since.keys()) if (!reading.has(id)) since.delete(id);
  for (const id of reading) if (!since.has(id)) since.set(id, now);
}

/**
 * How soon to look again while a source is being read: often at first, then rarely, so a
 * source stuck in `pending` doesn't keep every open tab asking every 2 seconds. A source
 * waiting for the daily AI budget can wait hours, so it isn't watched at all.
 */
export function pollDelay(
  sources: readonly KnowledgeSource[],
  now: number,
  since: ReadonlyMap<string, number>,
): number | false {
  const reading = sources.filter(beingRead);
  if (reading.length === 0) return false;
  const newest = Math.max(...reading.map((s) => since.get(s.id) ?? now));
  return now - newest < slowAfterMs ? fastPollMs : slowPollMs;
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
