import { Parser } from "htmlparser2";

/** Page chrome and non-content: never knowledge. */
const skippedTags = new Set([
  "head",
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "object",
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "button",
  "select",
]);
const blockTags = new Set([
  "p",
  "div",
  "section",
  "article",
  "main",
  "ul",
  "ol",
  "table",
  "tr",
  "pre",
  "blockquote",
  "dl",
  "dt",
  "dd",
  "hr",
  "br",
  "figure",
  "figcaption",
]);

/** Text a reader of the page can't see is often the vehicle for hidden instructions. */
function isHidden(attribs: Record<string, string>): boolean {
  if ("hidden" in attribs || attribs["aria-hidden"] === "true") return true;
  const style = (attribs.style ?? "").toLowerCase().replaceAll(/\s+/g, "");
  return /display:none|visibility:hidden|font-size:0(?![.\d])/.test(style);
}

export interface ExtractedPage {
  title: string | null;
  /** Plain text with markdown-style `#` headings, so the chunker can split on sections. */
  text: string;
}

/**
 * Readable text from an untrusted web page, in one linear pass (no regexes over the whole
 * page). Keeps only `<main>` when the page has one, and drops navigation, scripts and hidden
 * elements. Best effort: the text is still quoted to the model as data, which is the defence.
 */
export function extractHtml(html: string): ExtractedPage {
  const all: string[] = [];
  const main: string[] = [];
  let title = "";
  let inTitle = false;
  let skipDepth = 0;
  let mainDepth = 0;

  const emit = (s: string) => {
    all.push(s);
    if (mainDepth > 0) main.push(s);
  };

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (name === "title") inTitle = true;
        if (skipDepth > 0 || skippedTags.has(name) || isHidden(attribs)) {
          skipDepth++;
          return;
        }
        if (mainDepth > 0 || name === "main" || attribs.role === "main") mainDepth++;
        const heading = /^h([1-6])$/.exec(name);
        if (heading) emit(`\n\n${"#".repeat(Number(heading[1]))} `);
        else if (name === "li") emit("\n- ");
        else if (blockTags.has(name)) emit("\n\n");
      },
      ontext(data) {
        if (inTitle) title += data;
        if (skipDepth === 0) emit(data.replaceAll(/\s+/g, " "));
      },
      onclosetag(name) {
        if (name === "title") inTitle = false;
        if (skipDepth > 0) {
          skipDepth--;
          return;
        }
        if (/^h[1-6]$/.test(name) || blockTags.has(name)) emit("\n\n");
        if (mainDepth > 0) mainDepth--;
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();

  return {
    title: title.replaceAll(/\s+/g, " ").trim() || null,
    text: tidy((main.join("").trim() ? main : all).join("")),
  };
}

/** Trims each line and keeps at most one blank line between paragraphs. */
export function tidy(text: string): string {
  return text
    .replaceAll(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replaceAll(/[ \t]+/g, " ").trim())
    .join("\n")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim();
}
