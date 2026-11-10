import { randomBytes } from "node:crypto";
import { type Database, eq, schema, sql, type TenantTx } from "@helpos/db";
import { type SecretBox, SecretBoxError } from "../secrets/secret-box.ts";
import { type RepoName, repoString } from "./github-api.ts";

// The workspace's GitHub connection: the one repo, its token and its webhook secret. This is
// the only file that reads or writes the `integrations` row or opens what is sealed in it, so
// "is it connected, and is what we stored still readable" has one answer for the routes, the
// recheck job and the webhook. (A Biome plugin, biome-plugins/github-integration.grit, keeps
// it that way.) Every function takes the caller's `withTenant()` transaction.

const { integrations } = schema;

const isGithub = eq(integrations.provider, "github");

/** A tenant ID no workspace has: the decoy secret is sealed for it alone. */
const decoyTenant = "00000000-0000-4000-8000-000000000000";
const decoys = new WeakMap<SecretBox, string>();

/** The repo connected to this workspace, as `owner/name`, or null. */
export async function connectedRepo(tx: TenantTx): Promise<string | null> {
  const [row] = await tx.select({ repo: integrations.repo }).from(integrations).where(isGithub);
  return row?.repo ?? null;
}

/** What it takes to call GitHub for this workspace. */
export type GithubAccess = { repo: string; token: string };

/**
 * The connected repo and its token, opened. `not_connected`: nothing to call GitHub with.
 * `reconnect_required`: a token is stored but this server's key can't open it (the key
 * changed), so only connecting the repo again helps.
 */
export async function openGithubAccess(
  tx: TenantTx,
  box: SecretBox,
  tenantId: string,
): Promise<GithubAccess | "not_connected" | "reconnect_required"> {
  const [row] = await tx
    .select({ repo: integrations.repo, tokenCiphertext: integrations.tokenCiphertext })
    .from(integrations)
    .where(isGithub);
  if (!row) return "not_connected";
  try {
    return {
      repo: row.repo,
      token: box.open(row.tokenCiphertext, { tenantId, purpose: "github-token" }),
    };
  } catch (error) {
    if (!(error instanceof SecretBoxError)) throw error;
    return "reconnect_required";
  }
}

/**
 * The workspace's webhook secret: a string, null when it has no repo connected, or
 * `unreadable` when the stored one can't be opened with this key. A workspace with no repo
 * opens a throwaway secret instead, so the timing doesn't tell which workspaces exist.
 */
export async function loadWebhookSecret(
  db: Pick<Database, "withTenant">,
  box: SecretBox,
  tenantId: string,
): Promise<string | null | "unreadable"> {
  const [row] = await db.withTenant(tenantId, (tx) =>
    tx
      .select({ webhookSecretCiphertext: integrations.webhookSecretCiphertext })
      .from(integrations)
      .where(isGithub),
  );
  try {
    const secret = box.open(row?.webhookSecretCiphertext ?? decoySecret(box), {
      tenantId: row ? tenantId : decoyTenant,
      purpose: "github-webhook-secret",
    });
    return row ? secret : null;
  } catch (error) {
    if (!(error instanceof SecretBoxError)) throw error;
    return "unreadable";
  }
}

/** A sealed random secret, made once per key, opened when a workspace has no repo. */
function decoySecret(box: SecretBox): string {
  let sealed = decoys.get(box);
  if (!sealed) {
    sealed = box.seal(randomBytes(32).toString("hex"), {
      tenantId: decoyTenant,
      purpose: "github-webhook-secret",
    });
    decoys.set(box, sealed);
  }
  return sealed;
}

/**
 * Whether connecting `repo` again keeps the webhook secret the repo already has. Same repo (a
 * new token, say): the webhook set up in GitHub keeps working. Another repo needs a webhook of
 * its own, so it gets a new secret to paste there, as does asking. So does a secret that can't
 * be read any more (a new key): keeping it would keep the webhook broken, when reconnecting is
 * what the webhook's own warning says to do.
 */
export function keepsWebhookSecret(
  box: SecretBox,
  tenantId: string,
  current: { repo: string; webhookSecretCiphertext: string } | undefined,
  next: { repo: string; rotate: boolean },
): boolean {
  if (!current || current.repo !== next.repo || next.rotate) return false;
  try {
    box.open(current.webhookSecretCiphertext, { tenantId, purpose: "github-webhook-secret" });
    return true;
  } catch (error) {
    if (!(error instanceof SecretBoxError)) throw error;
    return false;
  }
}

/**
 * Stores the repo and its token (replacing an earlier connection) and returns the connection's
 * ID, plus the new webhook secret, which is null when the earlier one was kept.
 */
export async function connectIntegration(
  tx: TenantTx,
  box: SecretBox,
  input: { tenantId: string; repo: RepoName; token: string; rotateWebhookSecret: boolean },
): Promise<{ id: string; webhookSecret: string | null }> {
  const { tenantId } = input;
  const repo = repoString(input.repo);
  // One connect per workspace at a time. A row lock isn't enough: when there is no row yet,
  // it locks nothing, and two first connects would both insert.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`github-connect:${tenantId}`}, 0))`,
  );
  const [current] = await tx
    .select({
      repo: integrations.repo,
      webhookSecretCiphertext: integrations.webhookSecretCiphertext,
    })
    .from(integrations)
    .where(isGithub);
  const keep = keepsWebhookSecret(box, tenantId, current, {
    repo,
    rotate: input.rotateWebhookSecret,
  });
  const webhookSecret = keep ? null : randomBytes(32).toString("hex");
  const sealedSecret = webhookSecret
    ? box.seal(webhookSecret, { tenantId, purpose: "github-webhook-secret" })
    : null;
  const values = {
    repo,
    tokenCiphertext: box.seal(input.token, { tenantId, purpose: "github-token" }),
  };
  let row: { id: string } | undefined;
  if (current) {
    [row] = await tx
      .update(integrations)
      .set({
        ...values,
        ...(sealedSecret ? { webhookSecretCiphertext: sealedSecret } : {}),
        updatedAt: new Date(),
      })
      .where(isGithub)
      .returning({ id: integrations.id });
  } else {
    // A first connection always gets a new secret (nothing to keep): never an empty one.
    if (!sealedSecret) throw new Error("github connect: a new connection has no secret");
    [row] = await tx
      .insert(integrations)
      .values({ tenantId, provider: "github", ...values, webhookSecretCiphertext: sealedSecret })
      .returning({ id: integrations.id });
  }
  if (!row) throw new Error("github connect: write returned no row");
  return { id: row.id, webhookSecret };
}

/** Gives the connection a new webhook secret, keeping the token. Null: nothing is connected. */
export async function rotateWebhookSecret(
  tx: TenantTx,
  box: SecretBox,
  tenantId: string,
): Promise<{ id: string; webhookSecret: string } | null> {
  const webhookSecret = randomBytes(32).toString("hex");
  const [row] = await tx
    .update(integrations)
    .set({
      webhookSecretCiphertext: box.seal(webhookSecret, {
        tenantId,
        purpose: "github-webhook-secret",
      }),
      updatedAt: new Date(),
    })
    .where(isGithub)
    .returning({ id: integrations.id });
  return row ? { id: row.id, webhookSecret } : null;
}

/** Deletes the stored token and secret. The IDs of what was removed: empty if nothing was. */
export async function removeIntegration(tx: TenantTx): Promise<string[]> {
  const removed = await tx.delete(integrations).where(isGithub).returning({ id: integrations.id });
  return removed.map((r) => r.id);
}
