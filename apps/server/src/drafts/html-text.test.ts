import { describe, expect, it } from "vitest";
import { htmlToText, messageText } from "./html-text.ts";

describe("htmlToText", () => {
  it("keeps the words and line breaks, drops tags, scripts and styles", () => {
    const html =
      "<html><head><title>x</title><style>p{}</style></head><body><p>Hi&nbsp;there,</p>" +
      "<p>I can&#39;t log in &amp; need help.<br>Jane</p><script>alert(1)</script></body></html>";
    expect(htmlToText(html)).toBe("Hi there,\nI can't log in & need help.\nJane");
  });

  it("leaves unknown entities alone and ignores invalid code points", () => {
    expect(htmlToText("a &bogus; b &#99999999; c")).toBe("a &bogus; b c");
  });
});

describe("messageText", () => {
  it("prefers the text part, falls back to the HTML, and is empty with neither", () => {
    expect(messageText({ textBody: "plain", htmlBody: "<p>html</p>" })).toBe("plain");
    expect(messageText({ textBody: "  ", htmlBody: "<p>html</p>" })).toBe("html");
    expect(messageText({ textBody: null, htmlBody: null })).toBe("");
  });
});
