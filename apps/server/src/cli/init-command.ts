import { createAuthStore, createDatabase } from "@helpos/db";
import { z } from "zod";
import { defaultPublicUrl } from "../defaults.ts";
import { initWorkspace } from "../workspaces/init-workspace.ts";
import { passwordSetupLink } from "../workspaces/password-link.ts";

import { type CliOutput, parseArguments } from "./arguments.ts";

export async function run(
  args: string[],
  environment: Record<string, string | undefined>,
  output: CliOutput,
): Promise<number> {
  const values = parseArguments(args, {
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
    output.stderr.write(
      "Usage: pnpm helpos:init --workspace <name> --mailbox <address> --owner <email>\n",
    );
    return 2;
  }

  const env = z
    .object({
      HELPOS_DATABASE_URL: z.url(),
      HELPOS_DATABASE_AUTH_URL: z.url(),
      HELPOS_PUBLIC_URL: z.url().default(defaultPublicUrl),
    })
    .parse(environment);

  const db = createDatabase(env.HELPOS_DATABASE_URL);
  const auth = createAuthStore(env.HELPOS_DATABASE_AUTH_URL);
  try {
    const result = await initWorkspace({ db, auth }, input.data);
    if (!result.ok) {
      output.stderr.write(`The mailbox ${input.data.mailbox} is not available.\n`);
      return 1;
    } else {
      const verb = result.created ? "Created" : "Already set up:";
      output.stdout.write(`${verb} workspace ${result.tenantId} (${input.data.mailbox}).\n`);
      if (await auth.hasPassword(result.ownerId)) {
        output.stdout.write(`${input.data.owner} already has a password.\n`);
      } else {
        const { token, expiresAt } = await auth.issueSetupToken(result.ownerId);
        output.stdout.write(
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
  return 0;
}
