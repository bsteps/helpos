import { z } from "zod";

const toolCallSchema = z.object({
  toolName: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
});

const knowledgeSchema = z.strictObject({
  title: z.string().min(1),
  url: z.string().optional(),
  content: z.string().min(1),
  /** The team's private notes: the draft may follow them but never reveal them. */
  internal: z.boolean().optional(),
});

export const evalCaseSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1),
  input: z.strictObject({
    from: z.string(),
    subject: z.string(),
    body: z.string(),
    /** Knowledge passages, as retrieval would hand them to the drafter, best match first. */
    knowledge: z.array(knowledgeSchema).optional(),
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
      /** Knowledge titles the draft must cite. */
      mustCite: z.array(z.string()).default([]),
      /** Knowledge titles the draft must not cite. */
      mustNotCite: z.array(z.string()).default([]),
    })
    .refine(
      (a) =>
        a.mustContain.length +
          a.mustNotContain.length +
          a.mustNotMatch.length +
          a.mustNotCallTools.length +
          a.mustCite.length +
          a.mustNotCite.length >
        0,
      "A case needs at least one assertion",
    ),
});

export type EvalCase = z.infer<typeof evalCaseSchema>;
export type EvalInput = EvalCase["input"];
export type EvalAssertions = EvalCase["assert"];
