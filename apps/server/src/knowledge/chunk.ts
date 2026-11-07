/** Small enough to embed and quote precisely, big enough to keep a paragraph's context. */
export const maxChunkChars = 1_500;
/**
 * A source may have at most this many chunks. A longer one fails as `too_long` rather than
 * being cut short without a word, so a missing answer never hides at the end of a document.
 * Bounds one ingest's embedding cost.
 */
export const maxChunks = 200;

const headingLine = /^#{1,6}\s+\S/;

/** Splits a paragraph that is too long on its own, preferring sentence ends, then spaces. */
function splitLong(paragraph: string, limit: number): string[] {
  const parts: string[] = [];
  let rest = paragraph;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("? "));
    const space = window.lastIndexOf(" ");
    const cut = sentence > limit / 2 ? sentence + 1 : space > limit / 2 ? space : limit;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * Splits a document (plain text or markdown) into passages for embedding. A heading starts a
 * new passage, paragraphs are packed up to `maxChunkChars`, and a section's later passages
 * repeat its heading so each one still says what it's about.
 */
export function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let heading = "";
  let current: string[] = [];
  let size = 0;

  const flush = () => {
    const body = current.join("\n\n").trim();
    if (body && body !== heading) chunks.push(body);
    current = [];
    size = 0;
  };
  const add = (paragraph: string) => {
    const extra = paragraph.length + (current.length > 0 ? 2 : 0);
    if (size + extra > maxChunkChars && current.length > 0) {
      flush();
      if (heading) {
        current.push(heading);
        size = heading.length;
      }
    }
    current.push(paragraph);
    size += paragraph.length + (current.length > 1 ? 2 : 0);
  };

  const paragraphs = text
    .replaceAll(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n/)
    // Only the ends: indentation inside a paragraph (code, YAML, nested lists) is content.
    .map((p) => p.replace(/^\n+/, "").trimEnd())
    .filter((p) => p.trim());
  for (const paragraph of paragraphs) {
    // A heading glued to its first paragraph (no blank line) still starts a section.
    const [first = "", ...restLines] = paragraph.split("\n");
    if (headingLine.test(first)) {
      flush();
      // A very long heading is cut for repeating on later passages; the rest stays as text.
      heading = first.slice(0, 200);
      current.push(heading);
      size = heading.length;
      const rest = [first.slice(200), ...restLines].join("\n").trim();
      if (!rest) continue;
      for (const part of splitLong(rest, maxChunkChars - heading.length - 2)) add(part);
      continue;
    }
    const room = maxChunkChars - (heading ? heading.length + 2 : 0);
    for (const part of splitLong(paragraph, room)) add(part);
  }
  flush();
  return chunks;
}
