import { describe, expect, it } from "vitest";
import { chunkText, maxChunkChars, maxChunks } from "./chunk.ts";

describe("chunkText", () => {
  it("keeps a short document as one passage", () => {
    expect(chunkText("Refunds take 5 days.\n\nYou get an email.")).toEqual([
      "Refunds take 5 days.\n\nYou get an email.",
    ]);
  });

  it("starts a new passage at each heading, even one glued to its paragraph", () => {
    const doc = "# Refunds\nRefunds take 5 days.\n\n## Shipping\n\nShipping takes 3 days.";
    expect(chunkText(doc)).toEqual([
      "# Refunds\n\nRefunds take 5 days.",
      "## Shipping\n\nShipping takes 3 days.",
    ]);
  });

  it("drops headings with no text under them", () => {
    expect(chunkText("# Empty\n\n# Refunds\n\nFive days.")).toEqual(["# Refunds\n\nFive days."]);
  });

  it("packs paragraphs up to the limit and repeats the heading on later passages", () => {
    const paragraph = "word ".repeat(100).trim(); // 499 chars
    const doc = `# Long section\n\n${Array(6).fill(paragraph).join("\n\n")}`;
    const chunks = chunkText(doc);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.startsWith("# Long section\n\n")).toBe(true);
      expect(chunk.length).toBeLessThanOrEqual(maxChunkChars);
    }
  });

  it("splits one huge paragraph on sentence ends, never over the limit", () => {
    const sentence = "This sentence is about refunds and how long they take. ";
    const chunks = chunkText(sentence.repeat(200));
    expect(chunks.length).toBeGreaterThan(5);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(maxChunkChars);
      expect(chunk.endsWith(".")).toBe(true);
    }
  });

  it("hard-splits text with no spaces at all", () => {
    const chunks = chunkText("x".repeat(maxChunkChars * 2 + 10));
    expect(chunks.map((c) => c.length)).toEqual([maxChunkChars, maxChunkChars, 10]);
  });

  it("returns every passage, so the caller can refuse a document that's too long", () => {
    const doc = Array.from({ length: maxChunks + 20 }, (_, i) => `# H${i}\n\nText ${i}`).join(
      "\n\n",
    );
    expect(chunkText(doc)).toHaveLength(maxChunks + 20);
  });
  it("keeps indentation inside a paragraph, and the tail of a very long heading", () => {
    expect(chunkText("Config:\n  window_days: 30\n    nested: true")).toEqual([
      "Config:\n  window_days: 30\n    nested: true",
    ]);
    const long = `# ${"word ".repeat(50)}tail-words-here`;
    const [chunk = ""] = chunkText(`${long}\n\nBody.`);
    expect(chunk).toContain("tail-words-here");
    expect(chunk).toContain("Body.");
  });

  it("splits Chinese or Japanese text at sentence ends, not mid-sentence", () => {
    const sentence = `${"退款".repeat(40)}。`;
    const chunks = chunkText(sentence.repeat(30));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.endsWith("。"))).toBe(true);
  });

  it("doesn't take a # comment in a code block for a heading", () => {
    const doc = "# Install\n\n```bash\n# get the deps\nnpm install\n\n# start it\nnpm start\n```";
    expect(chunkText(doc)).toEqual([doc]);
  });

  it("returns nothing for blank text", () => {
    expect(chunkText(" \n\n \r\n ")).toEqual([]);
  });
});
