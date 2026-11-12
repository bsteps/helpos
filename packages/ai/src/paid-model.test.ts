import { describe, expect, it } from "vitest";
import { draftReply } from "./draft-reply.ts";
import { embedTexts } from "./embed.ts";
import { withPaidModels } from "./paid-model.ts";
import { mockEmbeddingModel, mockModel } from "./testing.ts";

const input = { from: "a", subject: "b", body: "c" };

describe("paid model lifetime", () => {
  it("refuses a model retained after its paid callback returns", async () => {
    const raw = mockModel();
    const model = await withPaidModels(new AbortController().signal, async (models) => models(raw));
    await expect(draftReply(model, input)).rejects.toThrow("paid AI call has ended");
    expect(raw.doGenerateCalls).toHaveLength(0);
  });

  it("refuses a factory retained after its paid callback returns", async () => {
    const raw = mockEmbeddingModel();
    const models = await withPaidModels(new AbortController().signal, async (models) => models);
    await expect(embedTexts(models(raw), ["query"])).rejects.toThrow("paid AI call has ended");
    expect(raw.doEmbedCalls).toHaveLength(0);
  });

  it("passes the budget signal to the provider and stops later calls on abort", async () => {
    const controller = new AbortController();
    const raw = mockModel();
    await withPaidModels(controller.signal, async (models) => {
      await draftReply(models(raw), input);
      expect(raw.doGenerateCalls[0]?.abortSignal).toBe(controller.signal);
      controller.abort(new Error("shutdown"));
      await expect(draftReply(models(raw), input)).rejects.toThrow("shutdown");
    });
    expect(raw.doGenerateCalls).toHaveLength(1);
  });
});
