/** Small enough to embed and quote precisely, big enough to keep a paragraph's context. */
export const maxChunkChars = 1_500;
/**
 * A source may have at most this many chunks. A longer one fails as `too_long` rather than
 * being cut short without a word, so a missing answer never hides at the end of a document.
 * Bounds one ingest's embedding cost.
 */
export const maxChunks = 200;

const headingLine = /^#{1,6}\s+\S/;
const fenceLine = /^ {0,3}(```|~~~)/;

/** Splits a paragraph that is too long on its own, preferring sentence ends, then spaces. */
function splitLong(paragraph: string, limit: number): string[] {
  const parts: string[] = [];
  let rest = paragraph;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    // Chinese and Japanese end sentences with full-width marks and no space after them.
    const sentence = Math.max(
      ...[". ", "? ", "! ", "。", "！", "？"].map((end) => window.lastIndexOf(end)),
    );
    const space = window.lastIndexOf(" ");
    let cut = sentence > limit / 2 ? sentence + 1 : space > limit / 2 ? space : limit;
    // Never between the two halves of one character (an emoji, a rare CJK character).
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut--;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * Splits a block that is too long. Prose is cut at sentences or spaces. A block with code is
 * cut between lines, and a code block cut in two is closed before the cut and opened again
 * after it, so every passage holds whole, fenced code.
 */
function splitBlock(block: string, limit: number): string[] {
  if (block.length <= limit) return [block];
  const lines = block.split("\n");
  if (!lines.some((line) => fenceLine.test(line))) return splitLong(block, limit);
  const parts: string[] = [];
  let current: string[] = [];
  let size = 0;
  let opener: string | undefined;
  for (const line of lines) {
    const closer = opener?.trimStart().startsWith("~~~") ? "~~~" : "```";
    const closing = opener !== undefined && fenceLine.test(line);
    // Room is kept for the closing fence a cut inside the code needs.
    const reserve = opener !== undefined && !closing ? closer.length + 1 : 0;
    if (current.length > 0 && size + line.length + 1 + reserve > limit) {
      parts.push([...current, ...(opener !== undefined ? [closer] : [])].join("\n"));
      current = opener !== undefined ? [opener] : [];
      size = opener !== undefined ? opener.length + 1 : 0;
    }
    current.push(line);
    size += line.length + 1;
    if (fenceLine.test(line)) opener = opener === undefined ? line : undefined;
  }
  if (current.length > 0) parts.push(current.join("\n"));
  // A single line longer than the limit still has to be cut.
  return parts.flatMap((part) => (part.length > limit ? splitLong(part, limit) : [part]));
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
  // A ``` or ~~~ code block can hold blank lines: it stays one block, so it isn't split
  // between passages at a blank line, and a `#` comment in it is never read as a heading.
  const blocks: string[] = [];
  let inFence = false;
  for (const paragraph of paragraphs) {
    const startsInFence = inFence;
    for (const line of paragraph.split("\n")) if (fenceLine.test(line)) inFence = !inFence;
    const last = blocks.length - 1;
    if (startsInFence && last >= 0) blocks[last] = `${blocks[last]}\n\n${paragraph}`;
    else blocks.push(paragraph);
  }
  for (const block of blocks) {
    // A heading glued to its first paragraph (no blank line) still starts a section.
    const [first = "", ...restLines] = block.split("\n");
    if (headingLine.test(first)) {
      flush();
      // A very long heading is cut for repeating on later passages; the rest stays as text.
      heading = first.slice(0, 200);
      current.push(heading);
      size = heading.length;
      const rest = [first.slice(200), ...restLines].join("\n").trim();
      if (!rest) continue;
      for (const part of splitBlock(rest, maxChunkChars - heading.length - 2)) add(part);
      continue;
    }
    const room = maxChunkChars - (heading ? heading.length + 2 : 0);
    for (const part of splitBlock(block, room)) add(part);
  }
  flush();
  return chunks;
}
