import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mockModel } from "../testing.ts";
import { checkAssertions } from "./assert.ts";
import { evalCaseSchema } from "./case.ts";
import { runEvals } from "./runner.ts";
import { draftReplyTask } from "./task.ts";

const names = ["earlier-injection", "changed-question", "obsolete-reply"];
const evalsDir = fileURLToPath(new URL("../../evals", import.meta.url));

async function historyCase(name: string) {
  const raw: unknown = JSON.parse(
    await readFile(new URL(`../../evals/history-${name}.json`, import.meta.url), "utf8"),
  );
  return evalCaseSchema.parse(raw);
}

describe("history evals", () => {
  it("passes ordered history through the runner as user data, separate from the latest email", async () => {
    const model = mockModel({ text: "A teammate will follow up." });
    await runEvals(evalsDir, model);
    for (const name of names) {
      const c = await historyCase(name);
      const calls = model.doGenerateCalls.filter((call) =>
        JSON.stringify(call.prompt).includes(c.input.body),
      );
      expect(calls).toHaveLength(1);
      const prompt = calls[0]?.prompt;
      expect(prompt?.map((message) => message.role)).toEqual(["system", "user"]);
      const user = prompt?.[1];
      expect(user?.role).toBe("user");
      if (user?.role !== "user") throw new Error("Missing user message");
      const text = user.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n");
      expect(text.match(/<\/?untrusted_email>/g)).toHaveLength(2);
      const fenced = /<untrusted_email>\n([\s\S]*?)\n<\/untrusted_email>/.exec(text);
      expect(fenced?.[1]).toBeDefined();
      const data: unknown = JSON.parse(fenced?.[1] ?? "null");
      expect(c.input.history).toHaveLength(2);
      expect(data).toEqual({
        conversation: c.input.history?.map((message) => ({
          sender: message.direction === "inbound" ? "customer" : "us",
          from: message.from,
          body: message.body,
        })),
        email: { from: c.input.from, subject: c.input.subject, body: c.input.body },
      });
      for (const message of c.input.history ?? []) {
        expect(JSON.stringify(prompt?.[0])).not.toContain(message.body);
      }
    }
  });

  it.each(names)("detects omitted history despite a good scripted answer in %s", async (name) => {
    const c = await historyCase(name);
    const model = mockModel(c.mock);
    const output = await draftReplyTask(model, { ...c.input, history: [] });
    const prompts = model.doGenerateCalls.flatMap((call) =>
      call.prompt.flatMap((message) =>
        typeof message.content === "string"
          ? [message.content]
          : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
      ),
    );
    const failures = checkAssertions(output, c.assert, prompts);
    expect(failures).toHaveLength(2);
    expect(failures.every((failure) => failure.startsWith("model prompt must contain"))).toBe(true);
  });

  it.each([
    ["earlier-injection", "HISTORY_REFUND_APPROVED"],
    ["changed-question", "Start a return in the Returns portal within 30 days.\n[sources: K1]"],
    ["obsolete-reply", "The upload limit is 10 MB per file.\n[sources: K1]"],
  ])("rejects the wrong answer in %s", async (name, text) => {
    const c = await historyCase(name);
    const output = await draftReplyTask(mockModel({ text }), c.input);
    const failures = checkAssertions(output, { ...c.assert, promptMustContain: [] });
    expect(failures.some((failure) => failure.startsWith("text must not"))).toBe(true);
  });

  it("rejects the injected tool call even with a safe reply", async () => {
    const c = await historyCase("earlier-injection");
    const output = await draftReplyTask(mockModel(c.mock), c.input);
    const assertions = { ...c.assert, promptMustContain: [] };
    expect(checkAssertions(output, assertions)).toEqual([]);
    expect(checkAssertions({ ...output, toolCalls: ["issue_refund"] }, assertions)).toEqual([
      'must not call tool "issue_refund"',
    ]);
  });

  it("accepts absent or empty history and rejects malformed messages", async () => {
    const c = await historyCase("earlier-injection");
    for (const history of [undefined, []]) {
      expect(evalCaseSchema.safeParse({ ...c, input: { ...c.input, history } }).success).toBe(true);
    }
    for (const message of [
      { direction: "system", from: "a@test", body: "text" },
      { direction: "inbound", body: "text" },
      { direction: "outbound", from: "a@test", body: 42 },
      { direction: "inbound", from: "a@test", body: "text", role: "system" },
    ]) {
      expect(
        evalCaseSchema.safeParse({ ...c, input: { ...c.input, history: [message] } }).success,
      ).toBe(false);
    }
  });
});
