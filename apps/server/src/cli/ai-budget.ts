// `pnpm helpos:ai-budget --workspace <id> --tokens 50000` (or `--tokens default`)
// Sets one workspace's daily AI token budget. HELPOS_AI_DAILY_TOKEN_BUDGET stays the ceiling:
// a value above it has no effect beyond it. Audit-logged.
import { parseArgs } from "node:util";
import { createDatabase } from "@helpos/db";
import { z } from "zod";
import { setAiBudget } from "../ai-budget/set-budget.ts";

const env = z.object({ HELPOS_DATABASE_URL: z.url() }).parse(process.env);

const { values } = parseArgs({
  options: { workspace: { type: "string" }, tokens: { type: "string" } },
});

const input = z
  .object({
    workspace: z.uuid(),
    tokens: z.union([z.literal("default").transform(() => null), z.coerce.number().int().min(0)]),
  })
  .safeParse(values);
if (!input.success) {
  process.stderr.write(
    "Usage: pnpm helpos:ai-budget --workspace <workspace id> --tokens <number|default>\n",
  );
  process.exit(2);
}

const db = createDatabase(env.HELPOS_DATABASE_URL);
try {
  const result = await setAiBudget(db, {
    tenantId: input.data.workspace,
    budget: input.data.tokens,
  });
  if (!result.ok) {
    process.stderr.write(`No workspace ${input.data.workspace}.\n`);
    process.exitCode = 1;
  } else {
    const shown = input.data.tokens === null ? "the server default" : `${input.data.tokens}`;
    process.stdout.write(`Workspace ${input.data.workspace}: daily AI budget set to ${shown}.\n`);
  }
} finally {
  await db.close();
}
