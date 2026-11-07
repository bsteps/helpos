// `pnpm helpos:token --mailbox support@acme.test --name triage-bot --scopes tickets:read,drafts:write`
// Creates an agent token for the workspace behind a mailbox and prints it, once. For the server
// operator: until human sessions exist (#46), nobody can call `POST /v1/tokens`.
import { parseArgs } from "node:util";
import { createDatabase, schema } from "@helpos/db";
import { z } from "zod";
import { createApiToken } from "../tokens/create-token.ts";

const env = z.object({ HELPOS_DATABASE_URL: z.url() }).parse(process.env);

const { values } = parseArgs({
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
  process.stderr.write(
    "Usage: pnpm helpos:token --mailbox <address> --name <agent name> --scopes <a,b,…>\n" +
      `Scopes: ${schema.apiTokenScopes.join(", ")}\n`,
  );
  process.exit(2);
}

const db = createDatabase(env.HELPOS_DATABASE_URL);
try {
  const route = await db.resolveMailbox(input.data.mailbox);
  if (!route) {
    process.stderr.write(`No workspace has the mailbox ${input.data.mailbox}.\n`);
    process.exitCode = 1;
  } else {
    const { tenantId } = route;
    const { row, token } = await db.withTenant(tenantId, (tx) =>
      createApiToken(tx, {
        tenantId,
        name: input.data.name,
        scopes: input.data.scopes,
        // Whoever can run this already holds the database credentials.
        actor: { type: "system", id: "cli" },
        requestId: null,
      }),
    );
    process.stderr.write(
      `Created token ${row.id} "${row.name}" (${row.scopes.join(", ")}). ` +
        "It is shown only now: store it in a secret manager.\n",
    );
    // The token alone on stdout, so it can be piped straight into a secret store.
    process.stdout.write(`${token}\n`);
  }
} finally {
  await db.close();
}
