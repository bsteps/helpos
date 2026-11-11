import { createDatabase } from "@helpos/db";
import { z } from "zod";
import { setAiBudget } from "../workspaces/ai-budget.ts";

import { type CliOutput, parseArguments } from "./arguments.ts";

export async function run(
  args: string[],
  environment: Record<string, string | undefined>,
  output: CliOutput,
): Promise<number> {
  const values = parseArguments(args, {
    options: { workspace: { type: "string" }, tokens: { type: "string" } },
  });

  const input = z
    .object({
      workspace: z.uuid(),
      tokens: z.union([z.literal("default").transform(() => null), z.coerce.number().int().min(0)]),
    })
    .safeParse(values);
  if (!input.success) {
    output.stderr.write(
      "Usage: pnpm helpos:ai-budget --workspace <workspace id> --tokens <number|default>\n",
    );
    return 2;
  }

  const env = z.object({ HELPOS_DATABASE_URL: z.url() }).parse(environment);

  const db = createDatabase(env.HELPOS_DATABASE_URL);
  try {
    const result = await setAiBudget(db, {
      tenantId: input.data.workspace,
      budget: input.data.tokens,
    });
    if (!result.ok) {
      output.stderr.write(`No workspace ${input.data.workspace}.\n`);
      return 1;
    } else {
      const shown = input.data.tokens === null ? "the server default" : `${input.data.tokens}`;
      output.stdout.write(`Workspace ${input.data.workspace}: daily AI budget set to ${shown}.\n`);
    }
  } finally {
    await db.close();
  }
  return 0;
}
