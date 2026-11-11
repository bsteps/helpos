import { draftReply } from "@helpos/ai";
import { mockModel } from "@helpos/ai/testing";
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

  it("only reads a bounded prefix of a huge email", () => {
    const huge = `<p>start</p>${"<b>x</b>".repeat(100_000)}<p>never reached</p>`;
    const text = htmlToText(huge);
    expect(text.startsWith("start")).toBe(true);
    expect(text).not.toContain("never reached");
  });
});

describe("messageText", () => {
  it("prefers the text part, falls back to the HTML, and is empty with neither", () => {
    expect(messageText({ textBody: "plain", htmlBody: "<p>html</p>" })).toBe("plain");
    expect(messageText({ textBody: "  ", htmlBody: "<p>html</p>" })).toBe("html");
    expect(messageText({ textBody: null, htmlBody: null })).toBe("");
  });
});

it("excludes hidden email instructions from the captured model input", async () => {
  const model = mockModel({ text: "Please reset your password." });
  const body = messageText({ textBody: null, htmlBody: '<p>Visible login question.</p><span style="display:none">hidden-display</span><div aria-hidden="true">hidden-aria</div><div style="visibility:hidden">hidden-visibility</div><p>Visible follow-up.</p>' });
  await draftReply(model, { from: "customer@example.com", subject: "Login", body });
  const prompt = JSON.stringify(model.doGenerateCalls[0]?.prompt);
  expect(prompt).toContain("Visible login question.");
  expect(prompt).toContain("Visible follow-up.");
  expect(prompt).not.toContain("hidden-display");
  expect(prompt).not.toContain("hidden-aria");
  expect(prompt).not.toContain("hidden-visibility");
});
