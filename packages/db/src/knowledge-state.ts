import { z } from "zod";

export const knowledgeFailureCodes = [
  "invalid_url",
  "blocked_address",
  "blocked_port",
  "insecure_redirect",
  "dns_failed",
  "timeout",
  "aborted",
  "too_large",
  "too_many_redirects",
  "network",
  "no_url",
  "no_text",
  "too_long",
  "unsupported_content_type",
  "embedding_unavailable",
  "embedding_failed",
  "ingest_error",
] as const;

const httpReason = z.strictObject({
  code: z.literal("http_error"),
  status: z.number().int().min(100).max(999),
});
export const knowledgeFailureReasonSchema = z.union([
  z.strictObject({ code: z.enum(knowledgeFailureCodes) }),
  httpReason,
]);
export const knowledgeWaitReasonSchema = z.union([
  z.strictObject({
    code: z.enum(["timeout", "network", "embedding_unavailable", "daily_budget_reached"]),
  }),
  z.strictObject({
    code: z.literal("http_error"),
    status: z.union([
      z.literal(408),
      z.literal(425),
      z.literal(429),
      z.literal(500),
      z.literal(502),
      z.literal(503),
      z.literal(504),
    ]),
  }),
]);
export const knowledgeSourceStateSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("pending") }),
  z.strictObject({ status: z.literal("ready") }),
  z.strictObject({ status: z.literal("failed"), reason: knowledgeFailureReasonSchema }),
  z.strictObject({
    status: z.literal("waiting"),
    reason: knowledgeWaitReasonSchema,
    retryAt: z.iso.datetime(),
  }),
]);
export type KnowledgeSourceState = z.infer<typeof knowledgeSourceStateSchema>;
export type KnowledgeFailureReason = z.infer<typeof knowledgeFailureReasonSchema>;
export type KnowledgeWaitReason = z.infer<typeof knowledgeWaitReasonSchema>;
