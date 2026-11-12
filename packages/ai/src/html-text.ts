import { Parser } from "htmlparser2";

const knowledgeSkippedTags = new Set([
  "head",
  "title",
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "object",
  "nav",
  "button",
  "select",
  "textarea",
]);
/**
 * The page's own header, footer and sidebars are chrome. Inside <main> or <article> they are
 * the article's: its title block, its notes. <form> is never skipped as a whole: some sites
 * wrap the entire page in one; its controls are skipped above.
 */
const knowledgeChromeTags = new Set(["header", "footer", "aside"]);
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

/** Marks <pre> lines until tidy() runs. Removed from the page's own text first, so a page can't fake it. */
const preformattedLineMarker = "\uE000";
const codeFence = "```";

/**
 * Text a reader of the page can't see is often the vehicle for hidden instructions. Inline
 * styles only: not shown, see-through, too small to read, moved off the screen, clipped
 * away, or squeezed into a box of no size. Hiding through a class or a stylesheet would take
 * a CSS engine to see, so it isn't caught. This filter does not prevent prompt injection.
 */
function isHidden(attribs: Record<string, string>): boolean {
  if ("hidden" in attribs || attribs["aria-hidden"] === "true") return true;
  const style = inlineStyle(attribs.style ?? "");
  const is = (property: string, test: RegExp) =>
    (style.get(property) ?? []).some((value) => test.test(value));
  const zero = /^-?0(\.0*)?[a-z%]*$/;
  const offScreen = /^-\d{3,}/;
  const noBox = ["height", "width", "max-height", "max-width"].some((p) => is(p, zero));
  return (
    is("display", /^none$/) ||
    is("visibility", /^(hidden|collapse)$/) ||
    is("font-size", zero) ||
    is("opacity", zero) ||
    is("color", /^transparent$/) ||
    ["left", "right", "top", "bottom", "text-indent"].some((p) => is(p, offScreen)) ||
    is("clip", /^rect\(0/) ||
    is("clip-path", /^(inset\(50%|circle\(0)/) ||
    (noBox && is("overflow", /^hidden$/))
  );
}

/**
 * An inline style's declarations: comments removed, and every value each property is given.
 * Property names are compared whole, so a comment or odd spacing before one can't hide it.
 * Every value counts, not only the last as in a browser: a browser skips a later value it
 * can't parse ("display:none; display:x" stays hidden), and guessing which ones it skips
 * would let hidden text through. A page that hides and then shows something loses that text.
 */
function inlineStyle(css: string): Map<string, string[]> {
  // Comments out in one pass. An unclosed one runs to the end, as in a browser.
  let text = "";
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("/*", i);
    if (open === -1) {
      text += css.slice(i);
      break;
    }
    text += `${css.slice(i, open)} `;
    const close = css.indexOf("*/", open + 2);
    if (close === -1) break;
    i = close + 2;
  }
  const declarations = new Map<string, string[]>();
  for (const declaration of text.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon === -1) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration
      .slice(colon + 1)
      .toLowerCase()
      .replace(/!\s*important\s*$/, "")
      .replaceAll(/\s+/g, "");
    const values = declarations.get(property);
    if (values) values.push(value);
    else declarations.set(property, [value]);
  }
  return declarations;
}

export interface ExtractedPage {
  /** Plain text with markdown-style `#` headings, so the chunker can split on sections. */
  text: string;
}

function extractText(html: string, format: "email" | "knowledge"): string {
  const email = format === "email";
  const all: string[] = [];
  const main: string[] = [];
  let skipDepth = 0;
  let mainDepth = 0;
  let preDepth = 0;
  let cellsInRow = 0;
  let articleDepth = 0;

  const emit = (s: string) => {
    all.push(s);
    if (mainDepth > 0) main.push(s);
  };

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        const chrome =
          !email && knowledgeChromeTags.has(name) && mainDepth === 0 && articleDepth === 0;
        if (
          skipDepth > 0 ||
          (email
            ? ["head", "script", "style", "template"].includes(name)
            : knowledgeSkippedTags.has(name)) ||
          chrome ||
          isHidden(attribs)
        ) {
          skipDepth++;
          return;
        }
        if (email) {
          emit(name === "br" ? "\n" : " ");
          return;
        }
        if (mainDepth > 0 || name === "main" || attribs.role === "main") mainDepth++;
        if (name === "pre") preDepth++;
        if (name === "article") articleDepth++;
        if (name === "tr") cellsInRow = 0;
        if (name === "td" || name === "th") {
          if (cellsInRow > 0) emit(" | ");
          cellsInRow++;
        }
        const heading = /^h([1-6])$/.exec(name);
        if (heading) emit(`\n\n${"#".repeat(Number(heading[1]))} `);
        else if (name === "li") emit("\n- ");
        else if (blockTags.has(name)) emit("\n\n");
        if (name === "pre" && preDepth === 1) emit(`${codeFence}\n`);
      },
      ontext(data) {
        if (skipDepth > 0) return;
        if (email) {
          emit(data.replaceAll("\u00a0", " "));
          return;
        }
        const clean = data.replaceAll(preformattedLineMarker, "");
        emit(
          preDepth > 0
            ? preformattedLineMarker + clean.replaceAll("\n", `\n${preformattedLineMarker}`)
            : clean.replaceAll(/\s+/g, " "),
        );
      },
      onclosetag(name) {
        if (skipDepth > 0) {
          skipDepth--;
          return;
        }
        if (email) {
          emit(/^(p|div|li|tr|h[1-6])$/.test(name) ? "\n" : " ");
          return;
        }
        if (name === "pre" && preDepth === 1) emit(`\n${codeFence}`);
        if (/^h[1-6]$/.test(name) || blockTags.has(name)) emit("\n\n");
        if (name === "pre") preDepth = Math.max(0, preDepth - 1);
        if (name === "article") articleDepth = Math.max(0, articleDepth - 1);
        if (mainDepth > 0) mainDepth--;
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();

  if (email)
    return all
      .join("")
      .replace(/[ \t]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  return tidy((main.join("").trim() ? main : all).join(""));
}

/**
 * NUL is valid text, but Postgres can't store it in a text column, so one stray NUL in a page
 * would fail every chunk insert. Never meaningful in an article.
 */
const nul = String.fromCharCode(0);

function tidy(text: string): string {
  return text
    .replaceAll(nul, "")
    .replaceAll(/\r\n?/g, "\n")
    .split("\n")
    .map((line) =>
      line.includes(preformattedLineMarker)
        ? line.replaceAll(preformattedLineMarker, "").trimEnd()
        : line.replaceAll(/[ \t]+/g, " ").trim(),
    )
    .join("\n")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim();
}

export const maxHtmlChars = 200_000;

export function htmlToText(html: string): string {
  return extractText(
    html.slice(0, maxHtmlChars).replace(/&#(\d+);/g, (entity, digits: string) => {
      const code = Number(digits);
      return code > 0 && code < 0x110000 ? entity : " ";
    }),
    "email",
  );
}

export function extractHtml(html: string): ExtractedPage {
  return { text: extractText(html, "knowledge") };
}

export function messageText(m: { textBody: string | null; htmlBody: string | null }): string {
  const text = m.textBody?.trim();
  if (text) return text;
  return m.htmlBody ? htmlToText(m.htmlBody) : "";
}
