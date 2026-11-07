const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * Rough plain text from untrusted HTML, only so an HTML-only email isn't drafted from nothing.
 * The result goes to the model as quoted data and is never rendered, so it needn't be perfect.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#\d+|[a-z]+);/gi, (match, name: string) => {
      if (name.startsWith("#")) {
        const code = Number(name.slice(1));
        return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : " ";
      }
      return entities[name.toLowerCase()] ?? match;
    })
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The text the model should read for one message: the text part, else text from the HTML. */
export function messageText(m: { textBody: string | null; htmlBody: string | null }): string {
  const text = m.textBody?.trim();
  if (text) return text;
  return m.htmlBody ? htmlToText(m.htmlBody) : "";
}
