// `pnpm helpos:init --workspace "Acme" --mailbox support@acme.test --owner you@acme.test`
// Creates a workspace with its support mailbox and owner. Safe to run again. While the owner
// has no password yet, it prints a one-time link to set one (a new link each run).
import { parseArgs } from "node:util";
import { createAuthStore, createDatabase } from "@helpos/db";
import { z } from "zod";
import { initWorkspace } from "../workspaces/init-workspace.ts";
import { passwordSetupLink } from "../workspaces/password-link.ts";

const env = z
  .object({
    HELPOS_DATABASE_URL: z.url(),
    HELPOS_DATABASE_AUTH_URL: z.url(),
    HELPOS_PUBLIC_URL: z.url().default("http://localhost:3000"),
  })
  .parse(process.env);

const { values } = parseArgs({
  options: {
    workspace: { type: "string" },
    mailbox: { type: "string" },
    owner: { type: "string" },
  },
});

const input = z
  .object({ workspace: z.string(), mailbox: z.string(), owner: z.string() })
  .safeParse(values);
if (!input.success) {
  process.stderr.write(
    "Usage: pnpm helpos:init --workspace <name> --mailbox <address> --owner <email>\n",
  );
  process.exit(2);
}

const db = createDatabase(env.HELPOS_DATABASE_URL);
const auth = createAuthStore(env.HELPOS_DATABASE_AUTH_URL);
try {
  const result = await initWorkspace({ db, auth }, input.data);
  if (!result.ok) {
    process.stderr.write(`The mailbox ${input.data.mailbox} is not available.\n`);
    process.exitCode = 1;
  } else {
    const verb = result.created ? "Created" : "Already set up:";
    process.stdout.write(`${verb} workspace ${result.tenantId} (${input.data.mailbox}).\n`);
    if (await auth.hasPassword(result.ownerId)) {
      process.stdout.write(`${input.data.owner} already has a password.\n`);
    } else {
      const { token, expiresAt } = await auth.createPasswordSetup(result.ownerId);
      process.stdout.write(
        `\nSet the owner's password with this one-time link (works until ${expiresAt.toISOString()}):\n` +
          `  ${passwordSetupLink(env.HELPOS_PUBLIC_URL, token)}\n` +
          "Anyone with the link can set the password, so send it only to the owner.\n",
      );
    }
  }
} finally {
  await db.close();
  await auth.close();
}
