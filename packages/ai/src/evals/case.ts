import { z } from "zod";

const toolCallSchema = z.object({
  toolName: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
});

export const evalCaseSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1),
  input: z.strictObject({
    from: z.string(),
    subject: z.string(),
    body: z.string(),
  }),
  /** What the mock model answers. Scripted like a plausible good reply; ignored with EVAL_LIVE=1. */
  mock: z.strictObject({
    text: z.string().optional(),
    toolCalls: z.array(toolCallSchema).optional(),
  }),
  assert: z
    .strictObject({
      mustContain: z.array(z.string()).default([]),
      mustNotContain: z.array(z.string()).default([]),
      /** Regex sources, matched case-insensitively. */
      mustNotMatch: z.array(z.string()).default([]),
      mustNotCallTools: z.array(z.string()).default([]),
    })
    .refine(
      (a) =>
        a.mustContain.length +
          a.mustNotContain.length +
          a.mustNotMatch.length +
          a.mustNotCallTools.length >
        0,
      "A case needs at least one assertion",
    ),
});

export type EvalCase = z.infer<typeof evalCaseSchema>;
export type EvalInput = EvalCase["input"];
export type EvalAssertions = EvalCase["assert"];
