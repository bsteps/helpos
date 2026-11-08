import { randomBytes } from "node:crypto";
import { type Database, enqueue, eq, schema, type TenantTx } from "@helpos/db";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import type { Logger } from "pino";
import { type SecretBox, SecretBoxError } from "../secrets/secret-box.ts";
import { githubWebhookActor } from "./fixed-notice.ts";
import { markIssueClosed, markIssueReopened, tiedLinks } from "./issue-state.ts";
import { recheckAfter, recheckIssueJob } from "./recheck.ts";
import { createGate, defaultGateLimits, type GateLimits, recentIds } from "./verify-gate.ts";
import { createWebhookSecrets, type WebhookSecrets } from "./webhook-secrets.ts";
import { signatureHeader, signatureMatches } from "./webhook-signature.ts";

const { integrations } = schema;

export interface GithubWebhookDeps {
  db: Pick<Database, "withTenant">;
  logger: Pick<Logger, "info" | "warn">;
  secretBox: SecretBox | undefined;
  noticeDelaySeconds?: number | undefined;
  /** For tests: how long before a tied event's issue state is read from GitHub. */
  issueRecheckSeconds?: number | undefined;
  /** Shared with the routes that change the secret, so they can forget it at once. */
  secrets?: WebhookSecrets;
  /** For tests: how many deliveries are checked at once, and how many may wait. */
  verifyLimits?: GateLimits;
}

export const webhookPath = "/v1/integrations/github/webhook";
/** A webhook delivery is a few KB; GitHub caps them at 25 MB. Nothing we read is near this. */
export const maxWebhookBytes = 1024 * 1024;

/**
 * A cached secret older than this is read again when a signature doesn't match it: the secret
 * may have been rotated by another server process. Younger, a mismatch is simply refused.
 */
const refreshAfterMs = 5_000;

/** GitHub's form content type wraps the same JSON in a `payload` field. */
const formPayload = z.object({ payload: z.string() });

const errorSchema = z.object({ error: z.string() }).openapi("Error");
const json = <T extends z.ZodType>(s: T, description: string) => ({
  description,
  content: { "application/json": { schema: s } },
});

/** The fields of GitHub's webhook payloads that we read. Everything else is ignored. */
const webhookPayload = z
  .object({
    action: z.string().optional(),
    issue: z
      .object({
        number: z.int().positive(),
        /** `completed`, `not_planned` or `duplicate`; missing on old deliveries. */
        state_reason: z.string().nullable().optional(),
        /** When this change happened, by GitHub's clock: orders late deliveries. */
        updated_at: z.iso.datetime({ offset: true }).optional(),
      })
      .optional(),
    // Null on some events (an organisation's, say): those are acknowledged and ignored.
    repository: z.object({ full_name: z.string() }).nullish(),
  })
  .openapi("GithubWebhookPayload");

const webhookRoute = createRoute({
  method: "post",
  path: webhookPath,
  summary: "Receive a GitHub webhook",
  description:
    "Called by GitHub with the connected repo's `issues` events. `?workspace=` names the " +
    "workspace; `X-Hub-Signature-256` must be the HMAC of the body with that workspace's " +
    "webhook secret. Tickets are matched by the event's repo and issue number, so issues made " +
    "while another repo was connected still close, as long as that repo's webhook has the " +
    "current secret. When an issue linked to tickets is closed as completed, each ticket gets " +
    "a `fixed` draft for a human to approve. A delivery for an issue already closed changes " +
    "nothing, so a replay is harmless. Other events are acknowledged and ignored.",
  security: [{ githubSignature: [] }],
  request: {
    query: z.object({ workspace: z.uuid() }),
    // GitHub sends JSON or, if the webhook was set up with its form content type, the same
    // JSON in a `payload` field. Both work: an admin can't get it wrong. Not `required`, so
    // only the validator for the type actually sent runs.
    body: {
      required: false,
      content: {
        "application/json": { schema: webhookPayload },
        "application/x-www-form-urlencoded": { schema: formPayload },
      },
    },
  },
  responses: {
    200: json(
      z.object({ status: z.enum(["processed", "ignored"]), tickets: z.int() }),
      "Handled. `tickets` is how many linked tickets changed",
    ),
    401: json(errorSchema, "Unknown workspace, no repo connected, or a missing or wrong signature"),
    400: json(errorSchema, "Not a GitHub event payload"),
    413: json(errorSchema, `Larger than ${maxWebhookBytes} bytes`),
    503: json(errorSchema, "Too many deliveries waiting to be checked (`busy`); try again"),
    415: json(errorSchema, "Neither JSON nor GitHub's form encoding"),
  },
});

declare module "hono" {
  interface ContextVariableMap {
    /** Set once a webhook's signature checks out. */
    githubWebhook: { tenantId: string };
  }
}

/**
 * GitHub's issue events for the connected repo. It has no session or token: the signature
 * under the workspace's own webhook secret is what authenticates it.
 */
export function registerGithubWebhook(app: OpenAPIHono, deps: GithubWebhookDeps): void {
  app.openAPIRegistry.registerComponent("securitySchemes", "githubSignature", {
    type: "apiKey",
    in: "header",
    name: "X-Hub-Signature-256",
    description: "`sha256=` and the hex HMAC-SHA256 of the raw body under the webhook secret.",
  });
  app.use(
    webhookPath,
    bodyLimit({
      maxSize: maxWebhookBytes,
      onError: (c) => c.json({ error: "too_large" }, 413),
    }),
  );
  // Unsigned requests can't be told from GitHub's until a secret is read from the database,
  // so a flood of forged ones would each take a pooled connection: they take turns instead.
  const gate = createGate(deps.verifyLimits ?? defaultGateLimits);
  const secrets = deps.secrets ?? createWebhookSecrets();
  // Workspaces with a delivery verified lately: their lookups go first (see the gate).
  const known = recentIds(10_000);
  // Workspaces already warned about an unreadable secret: once each, not once per request, so
  // forged requests can't flood the log with it.
  const warned = recentIds(10_000);
  const warnUnreadable = (tenantId: string) => {
    if (warned.has(tenantId)) return;
    warned.add(tenantId);
    deps.logger.warn(
      { tenantId },
      "github webhook: stored secret can't be read; reconnect the repo",
    );
  };
  // One lookup per workspace at a time: requests arriving meanwhile share its answer, so a
  // burst naming one workspace takes at most one place in the gate's line.
  const lookups = new Map<string, Promise<string | null | "busy">>();
  const secretFor = async (
    tenantId: string,
    body: Uint8Array,
    signature: string,
  ): Promise<string | null | "busy"> => {
    const cached = secrets.get(tenantId);
    // Read moments ago, or it matches: no database work. A mismatch on an older entry reads
    // again (another server process may have rotated the secret), but only then.
    if (
      cached &&
      (cached.ageMs < refreshAfterMs ||
        (cached.secret !== null && signatureMatches(cached.secret, body, signature)))
    ) {
      return cached.secret;
    }
    // Keyed by generation too: once the secret is changed, a request doesn't wait on a
    // lookup that may have read the old one.
    const generation = secrets.generation(tenantId);
    const key = `${tenantId}:${generation}`;
    const running = lookups.get(key);
    if (running) return running;
    const lookup = (async () => {
      const release = await gate(tenantId, known.has(tenantId));
      if (!release) return "busy" as const;
      try {
        const secret = await loadSecret(deps, tenantId, warnUnreadable);
        secrets.set(tenantId, secret, generation);
        return secret;
      } finally {
        release();
      }
    })();
    lookups.set(key, lookup);
    try {
      return await lookup;
    } finally {
      lookups.delete(key);
    }
  };
  // Before validation, so a caller without the secret learns nothing, not even a 400. A
  // request that isn't even shaped like a signed delivery is refused before any database work.
  app.use(webhookPath, async (c, next) => {
    const signature = c.req.header("x-hub-signature-256") ?? "";
    const workspace = z.uuid().safeParse(c.req.query("workspace"));
    if (!signatureHeader.test(signature) || !workspace.success) {
      return c.json({ error: "unauthorized" }, 401);
    }
    // One spelling per workspace: the cache, the gate's share and the secret's binding all key
    // on it.
    const tenantId = workspace.data.toLowerCase();
    // The body first: a client sending it slowly holds no place in line. Hono keeps it, so
    // validation afterwards parses these same bytes.
    const body = new Uint8Array(await c.req.arrayBuffer());
    const secret = await secretFor(tenantId, body, signature);
    if (secret === "busy") {
      c.header("Retry-After", "5");
      return c.json({ error: "busy" }, 503);
    }
    // The HMAC is computed whether or not there is a secret, so an unknown workspace's 401
    // takes as long as a wrong signature's. Every miss gives the same 401.
    const matches = signatureMatches(secret ?? "", body, signature);
    if (secret === null || !matches) return c.json({ error: "unauthorized" }, 401);
    known.add(tenantId);
    // Readable again (reconnected): if it breaks later, that's worth a warning again.
    warned.delete(tenantId);
    c.set("githubWebhook", { tenantId });
    return next();
  });

  app.openapi(webhookRoute, async (c) => {
    const { tenantId } = c.get("githubWebhook");
    const event = c.req.header("x-github-event");
    const type = c.req.header("content-type");
    const payload = readPayload(type, () =>
      type?.toLowerCase().startsWith("application/json")
        ? c.req.valid("json")
        : c.req.valid("form"),
    );
    if (payload === "unsupported") return c.json({ error: "unsupported_media_type" }, 415);
    if (payload === "invalid") return c.json({ error: "invalid_payload" }, 400);
    const ignored = { status: "ignored" as const, tickets: 0 };
    if (event !== "issues" || !payload.issue || !payload.repository) return c.json(ignored, 200);
    // The event's own repo, not only the connected one: a ticket linked while another repo was
    // connected keeps its link, and still hears when that issue closes. Only a webhook that
    // signs with this workspace's secret gets here, so every repo it speaks for is one an
    // admin of this workspace set it up on.
    const repo = payload.repository.full_name.toLowerCase();
    const issue = payload.issue;
    const requestId = c.get("requestId");

    const change = {
      tenantId,
      repo,
      number: issue.number,
      actor: githubWebhookActor,
      requestId,
      noticeDelaySeconds: deps.noticeDelaySeconds,
      changedAt: issue.updated_at ? new Date(issue.updated_at) : null,
    };
    const answer = (changed: number) =>
      c.json(
        { status: changed > 0 ? ("processed" as const) : ("ignored" as const), tickets: changed },
        200,
      );
    // An event in the same second as the link's last change can't be ordered against it, so
    // the worker reads the issue's state from GitHub for those links instead.
    const recheckTied = async (tx: TenantTx, from: "open" | "closed") => {
      for (const linkId of await tiedLinks(tx, change, from)) {
        // One waiting recheck per link: a redelivered event doesn't queue another.
        await enqueue(
          tx,
          recheckIssueJob,
          { tenantId, linkId },
          { startAfter: recheckAfter(deps.issueRecheckSeconds), singletonKey: `tie:${linkId}` },
        );
      }
    };
    if (payload.action === "closed") {
      const changed = await deps.db.withTenant(tenantId, async (tx) => {
        await recheckTied(tx, "open");
        return markIssueClosed(tx, { ...change, stateReason: issue.state_reason });
      });
      deps.logger.info({ issue: issue.number, tickets: changed }, "github issue closed");
      return answer(changed);
    }
    if (payload.action === "reopened") {
      const changed = await deps.db.withTenant(tenantId, async (tx) => {
        await recheckTied(tx, "closed");
        return markIssueReopened(tx, change);
      });
      return answer(changed);
    }
    return c.json(ignored, 200);
  });
}

type WebhookPayload = z.infer<typeof webhookPayload>;

/**
 * The event, from either of GitHub's content types. Hono types the validated body as either
 * shape whatever was sent, so it is parsed again here: a few fields, already checked once.
 */
function readPayload(
  contentType: string | undefined,
  body: () => unknown,
): WebhookPayload | "invalid" | "unsupported" {
  const type = (contentType ?? "").split(";")[0]?.trim().toLowerCase();
  let raw: unknown;
  if (type === "application/json") raw = body();
  else if (type === "application/x-www-form-urlencoded") {
    const form = formPayload.safeParse(body());
    if (!form.success) return "invalid";
    try {
      raw = JSON.parse(form.data.payload);
    } catch {
      return "invalid";
    }
  } else return "unsupported";
  const event = webhookPayload.safeParse(raw);
  return event.success ? event.data : "invalid";
}

/**
 * The workspace's webhook secret, or null when it has no repo connected or the secret can't
 * be read. Both do the same work (open a sealed secret), so the timing doesn't tell which
 * workspaces exist: a workspace with no repo opens a throwaway secret instead.
 */
async function loadSecret(
  deps: GithubWebhookDeps,
  tenantId: string,
  unreadable: (tenantId: string) => void,
): Promise<string | null> {
  const box = deps.secretBox;
  if (!box) return null;
  const [row] = await deps.db.withTenant(tenantId, (tx) =>
    tx
      .select({ webhookSecretCiphertext: integrations.webhookSecretCiphertext })
      .from(integrations)
      .where(eq(integrations.provider, "github")),
  );
  try {
    const secret = box.open(row?.webhookSecretCiphertext ?? decoySecret(box), {
      tenantId: row ? tenantId : decoyTenant,
      purpose: "github-webhook-secret",
    });
    return row ? secret : null;
  } catch (error) {
    if (!(error instanceof SecretBoxError)) throw error;
    unreadable(tenantId);
    return null;
  }
}

/** A tenant ID no workspace has: the decoy secret is sealed for it alone. */
const decoyTenant = "00000000-0000-4000-8000-000000000000";
const decoys = new WeakMap<SecretBox, string>();

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
