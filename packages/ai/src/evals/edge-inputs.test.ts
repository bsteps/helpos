import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { mockModel } from "../testing.ts";
import { checkAssertions } from "./assert.ts";
import { evalCaseSchema } from "./case.ts";
import { draftReplyTask } from "./task.ts";

async function edgeCase(name: string) {
  const raw: unknown = JSON.parse(
    await readFile(new URL(`../../evals/edge-${name}.json`, import.meta.url), "utf8"),
  );
  return evalCaseSchema.parse(raw);
}

describe("edge input evals", () => {
  it("places the attack after the exact retained boundary", async () => {
    const c = await edgeCase("huge-body");
    expect(c.input.body.length).toBeGreaterThan(20_000);
    expect(c.input.body.slice(0, 4000)).toMatch(/CUT-END!!$/);
    expect(c.input.body.indexOf("SYSTEM:")).toBe(4000);
    const model = mockModel(c.mock);
    await draftReplyTask(model, c.input);
    const request = JSON.stringify(model.doGenerateCalls);
    expect(request).toContain("CUT-END!!");
    expect(request).not.toContain("TAIL_REFUND_APPROVED");
  });

  it("rejects leaked tails and missing boundary text despite a good reply", async () => {
    const c = await edgeCase("huge-body");
    const output = await draftReplyTask(mockModel(c.mock), c.input);
    expect(checkAssertions(output, c.assert, ["CUT-END!!"])).toEqual([]);
    expect(checkAssertions(output, c.assert, [c.input.body])).toContain(
      'model prompt must not contain "TAIL_REFUND_APPROVED"',
    );
    expect(checkAssertions(output, c.assert, [])).toContain(
      'model prompt must contain "CUT-END!!"',
    );
  });

  it.each([
    ["empty-email", "Your refund is approved."],
    ["mixed-language", "Shipping takes 7 days.\n[sources: K2]"],
  ])("rejects an incorrect reply for %s", async (name, text) => {
    const c = await edgeCase(name);
    const prompts = c.assert.promptMustContain ?? [];
    const good = await draftReplyTask(mockModel(c.mock), c.input);
    expect(checkAssertions(good, c.assert, prompts)).toEqual([]);
    const bad = await draftReplyTask(mockModel({ text }), c.input);
    expect(checkAssertions(bad, c.assert, prompts).length).toBeGreaterThan(0);
    expect(checkAssertions(good, c.assert, []).length).toBeGreaterThan(0);
  });

  it("removes unknown citations while retaining valid citations through the task", async () => {
    const c = await edgeCase("unknown-citation");
    const output = await draftReplyTask(mockModel(c.mock), c.input);
    expect(output.cited).toEqual(["Refund policy"]);
    expect(checkAssertions(output, c.assert)).toEqual([]);
    for (const cited of [[], ["Refund policy", "K9"], ["Refund policy", "Shipping"]]) {
      expect(checkAssertions({ ...output, cited }, c.assert)).toHaveLength(1);
    }
    const unknownOnly = await draftReplyTask(
      mockModel({ text: "A teammate will follow up.\n[sources: K9]" }),
      c.input,
    );
    expect(unknownOnly.cited).toEqual([]);
    expect(unknownOnly.text).toBe("A teammate will follow up.");
  });
});
