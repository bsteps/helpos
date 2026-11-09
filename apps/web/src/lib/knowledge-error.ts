const messages: Record<string, string> = {
  blocked_address: "This address is private or local, so it isn't fetched.",
  no_url: "This source has no address to fetch.",
  timeout: "The site took too long to answer.",
  network: "Couldn't reach the site.",
  no_text: "The page has no text to use.",
  too_large: "The page is too large to fetch.",
  too_long: "It's too long for one source. Split it into smaller ones.",
  unsupported_content_type: "This address isn't a web page or text.",
  embedding_unavailable: "The AI service couldn't process it. It tries again by itself.",
  embedding_failed: "The AI service couldn't process it. It tries again by itself.",
  daily_budget_reached: "Waiting for today's AI budget to reset at midnight UTC.",
};

export function knowledgeErrorMessage(code: string): string {
  const known = messages[code];
  if (known) return known;
  const status = /^http_(\d{3})$/.exec(code)?.[1];
  if (status === "404" || status === "410") return `The page wasn't found (HTTP ${status}).`;
  if (status) return `The site answered with an error (HTTP ${status}).`;
  return `Reading it failed (${code}).`;
}
