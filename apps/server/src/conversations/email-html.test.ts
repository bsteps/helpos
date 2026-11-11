import { readFileSync } from "node:fs";
import { parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { parseEmail } from "../inbound-email/parse.ts";
import { sanitizeEmailHtml } from "./email-html.ts";

// ADR 0004: customer HTML is data. The XSS fixture collects the classic ways an email tries to
// run code, phone home or phish; none of them may survive.

/** Every element and attribute name in the output, as a browser's parser would see them. */
function elementsOf(html: string): { tags: Set<string>; attributes: Set<string> } {
  const tags = new Set<string>();
  const attributes = new Set<string>();
  const walk = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    if ("name" in node && typeof node.name === "string") tags.add(node.name);
    if ("attribs" in node && typeof node.attribs === "object" && node.attribs !== null) {
      for (const name of Object.keys(node.attribs)) attributes.add(name.toLowerCase());
    }
    if ("children" in node && Array.isArray(node.children)) node.children.forEach(walk);
  };
  walk(parseDocument(html));
  return { tags, attributes };
}

async function fixtureHtml(): Promise<string> {
  const raw = readFileSync(new URL("../../../../fixtures/email/xss.eml", import.meta.url));
  const email = await parseEmail(new Uint8Array(raw));
  if (!email.html) throw new Error("fixture has no HTML part");
  return email.html;
}

describe("sanitizeEmailHtml with the XSS fixture", () => {
  it("keeps the readable content and harmless formatting", async () => {
    const safe = sanitizeEmailHtml(await fixtureHtml());
    expect(safe).toContain("XSS-SAFE-MARKER: my <b>invoice</b> is <i>wrong</i>.");
    expect(safe).toContain('<p style="color:red;font-weight:bold">red text stays</p>');
    expect(safe).toContain("<td>cell</td>");
  });

  it("leaves no script, event handler or script URL anywhere", async () => {
    const safe = sanitizeEmailHtml(await fixtureHtml());
    const { tags, attributes } = elementsOf(safe);
    expect(tags.has("script")).toBe(false);
    expect([...attributes].filter((a) => a.startsWith("on"))).toEqual([]);
    expect(safe).not.toMatch(/javascript:|data:text\/html|data:image\/svg/i);
  });

  it("drops every element that can load, embed, redirect or submit", async () => {
    const safe = sanitizeEmailHtml(await fixtureHtml());
    const { tags } = elementsOf(safe);
    for (const tag of [
      "base",
      "meta",
      "link",
      "style",
      "iframe",
      "object",
      "embed",
      "form",
      "input",
      "button",
      "svg",
      "math",
      "video",
      "audio",
    ]) {
      expect(tags.has(tag), tag).toBe(false);
    }
  });

  it("never points at the sender's server: remote images become their alt text", async () => {
    const safe = sanitizeEmailHtml(await fixtureHtml());
    expect(safe).not.toContain("evil.test");
    expect(safe).toContain("<span>[image: tracking pixel]</span>");
    expect(safe).toContain("<span>[image: relative]</span>");
    expect(safe).not.toMatch(/<img/i);
  });

  it("drops styles that could fetch something, keeping the element", async () => {
    const safe = sanitizeEmailHtml(await fixtureHtml());
    expect(safe).toContain("<div>styled with a remote background</div>");
    expect(safe).toContain("<div>escaped url</div>");
  });

  it("opens links in a new tab, with no referrer and no handle back to us", async () => {
    const safe = sanitizeEmailHtml(await fixtureHtml());
    expect(safe).toContain(
      '<a href="https://example.test/help" target="_blank" rel="noopener noreferrer nofollow">a normal link</a>',
    );
    // A javascript: link keeps its text and loses its target.
    expect(safe).toMatch(/<a target="_blank" rel="noopener noreferrer nofollow">click me<\/a>/);
  });
});

describe("sanitizeEmailHtml", () => {
  it("keeps an inline raster image", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    expect(sanitizeEmailHtml(`<img src="${png}" alt="logo">`)).toBe(
      `<img src="${png}" alt="logo" />`,
    );
  });

  it("blocks an image without alt text with a plain placeholder", () => {
    expect(sanitizeEmailHtml('<img src="http://x.test/a.png">')).toBe("<span>[image]</span>");
  });

  it("only keeps what is inside <body>", () => {
    expect(
      sanitizeEmailHtml("<html><head><title>t</title></head><body><p>hi</p></body></html>"),
    ).toBe("<p>hi</p>");
  });
});
