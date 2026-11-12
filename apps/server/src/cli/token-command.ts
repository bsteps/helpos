import { createDatabase, schema } from "@helpos/db";
import { z } from "zod";
import { createApiToken } from "../tokens/create-token.ts";

import { type CliOutput, parseArguments } from "./arguments.ts";

export async function run(
  args: string[],
  environment: Record<string, string | undefined>,
  output: CliOutput,
): Promise<number> {
  const values = parseArguments(args, {
    options: {
      mailbox: { type: "string" },
      name: { type: "string" },
      scopes: { type: "string" },
    },
  });

  const input = z
    .object({
      mailbox: z.email().trim().toLowerCase(),
      name: z.string().trim().min(1).max(100),
      scopes: z
        .string()
        .transform((s) => s.split(",").map((x) => x.trim()))
        .pipe(z.array(z.enum(schema.apiTokenScopes)).min(1)),
    })
    .safeParse(values);
  if (!input.success) {
    output.stderr.write(
      "Usage: pnpm helpos:token --mailbox <address> --name <agent name> --scopes <a,b,…>\n" +
        `Scopes: ${schema.apiTokenScopes.join(", ")}\n`,
    );
    return 2;
  }

  const env = z.object({ HELPOS_DATABASE_URL: z.url() }).parse(environment);

  const db = createDatabase(env.HELPOS_DATABASE_URL);
  try {
    const route = await db.resolveMailbox(input.data.mailbox);
    if (!route) {
      output.stderr.write(`No workspace has the mailbox ${input.data.mailbox}.\n`);
      return 1;
    } else {
      const { tenantId } = route;
      const { row, token } = await db.withTenant(tenantId, (tx) =>
        createApiToken(tx, {
          tenantId,
          name: input.data.name,
          scopes: input.data.scopes,
          actor: { type: "system", id: "cli" },
          requestId: null,
        }),
      );
      output.stderr.write(
        `Created token ${row.id} "${row.name}" (${row.scopes.join(", ")}). ` +
          "It is shown only now: store it in a secret manager.\n",
      );
      output.stdout.write(`${token}\n`);
    }
  } finally {
    await db.close();
  }
  return 0;
}
