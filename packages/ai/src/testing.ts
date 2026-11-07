import { MockLanguageModelV4 } from "ai/test";

export type MockToolCall = { toolName: string; input: Record<string, unknown> };
export type MockResponse = {
  text?: string | undefined;
  toolCalls?: MockToolCall[] | undefined;
  /** Tokens the mock reports per call, e.g. to test spend caps. Zero by default. */
  usage?: { inputTokens: number; outputTokens: number } | undefined;
};

/**
 * A model that returns a scripted response and never touches the network.
 * Every unit, integration and CI eval run uses this: CI never calls a real provider.
 */
export function mockModel(response: MockResponse = {}): MockLanguageModelV4 {
  const toolCalls = response.toolCalls ?? [];
  const input = response.usage?.inputTokens ?? 0;
  const output = response.usage?.outputTokens ?? 0;
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: "mock-model",
    doGenerate: {
      content: [
        ...(response.text === undefined ? [] : [{ type: "text" as const, text: response.text }]),
        ...toolCalls.map((call, i) => ({
          type: "tool-call" as const,
          toolCallId: `mock-call-${i}`,
          toolName: call.toolName,
          input: JSON.stringify(call.input),
        })),
      ],
      finishReason: { unified: toolCalls.length > 0 ? "tool-calls" : "stop", raw: undefined },
      usage: {
        inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: output, text: output, reasoning: 0 },
      },
      warnings: [],
    },
  });
}
