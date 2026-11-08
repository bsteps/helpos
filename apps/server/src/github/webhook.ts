import { randomBytes } from "node:crypto";
import { type Database, eq, schema } from "@helpos/db";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Logger } from "pino";
import { type SecretBox, SecretBoxError } from "../secrets/secret-box.ts";
import { githubWebhookActor } from "./fixed-notice.ts";
import { markIssueClosed, markIssueReopened } from "./issue-state.ts";
import { signatureMatches } from "./webhook-signature.ts";

const { integrations } = schema;

export interface GithubWebhookDeps {
  db: Pick<Database, "withTenant">;
  logger: Pick<Logger, "info" | "warn">;
  secretBox: SecretBox | undefined;
  noticeDelaySeconds?: number | undefined;
}

export const webhookPath = "/v1/integrations/github/webhook";
/** A webhook delivery is a few KB; GitHub caps them at 25 MB. Nothing we read is near this. */
export const maxWebhookBytes = 1024 * 1024;

/** What GitHub sends; anything else is refused without touching the database. */
const signatureShape = /^sha256=[0-9a-fA-F]{64}$/;

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
      })
      .optional(),
    repository: z.object({ full_name: z.string() }).optional(),
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
        "application/x-www-form-urlencoded": { schema: z.object({ payload: z.string() }) },
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
  // Before validation, so a caller without the secret learns nothing, not even a 400. A
  // request that isn't even shaped like a signed delivery is refused before any database work.
  app.use(webhookPath, async (c, next) => {
    const signature = c.req.header("x-hub-signature-256") ?? "";
    const workspace = z.uuid().safeParse(c.req.query("workspace"));
    if (!signatureShape.test(signature) || !workspace.success) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const verified = await verifyWebhook(c, deps);
    if (!verified) return c.json({ error: "unauthorized" }, 401);
    c.set("githubWebhook", verified);
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
    };
    const answer = (changed: number) =>
      c.json(
        { status: changed > 0 ? ("processed" as const) : ("ignored" as const), tickets: changed },
        200,
      );
    if (payload.action === "closed") {
      const changed = await deps.db.withTenant(tenantId, (tx) =>
        markIssueClosed(tx, { ...change, stateReason: issue.state_reason }),
      );
      deps.logger.info({ issue: issue.number, tickets: changed }, "github issue closed");
      return answer(changed);
    }
    if (payload.action === "reopened") {
      return answer(await deps.db.withTenant(tenantId, (tx) => markIssueReopened(tx, change)));
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
    const form = z.object({ payload: z.string() }).safeParse(body());
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
 * The workspace a webhook is for, once its signature checks out under that workspace's own
 * secret. An unknown workspace, one with no repo, an unreadable secret and a bad signature all
 * give the same null, so a caller can't tell which workspaces exist.
 */
async function verifyWebhook(
  c: Context,
  deps: GithubWebhookDeps,
): Promise<{ tenantId: string } | null> {
  const workspace = z.uuid().safeParse(c.req.query("workspace"));
  const box = deps.secretBox;
  if (!workspace.success || !box) return null;
  const tenantId = workspace.data;
  const [row] = await deps.db.withTenant(tenantId, (tx) =>
    tx
      .select({ webhookSecretCiphertext: integrations.webhookSecretCiphertext })
      .from(integrations)
      .where(eq(integrations.provider, "github")),
  );
  // Every path does the same work from here: open a sealed secret, read the body, compute the
  // HMAC. A workspace with no repo uses a throwaway secret that can never match, so its 401
  // takes as long as a wrong signature's and the timing doesn't tell which workspaces exist.
  let secret: string | null = null;
  try {
    secret = box.open(row?.webhookSecretCiphertext ?? decoySecret(box), {
      tenantId: row ? tenantId : decoyTenant,
      purpose: "github-webhook-secret",
    });
  } catch (error) {
    if (!(error instanceof SecretBoxError)) throw error;
    deps.logger.warn(
      { tenantId },
      "github webhook: stored secret can't be read; reconnect the repo",
    );
  }
  // Read once here and cached by Hono, so validation afterwards parses these same bytes.
  const body = new Uint8Array(await c.req.arrayBuffer());
  const matches = signatureMatches(secret ?? "", body, c.req.header("x-hub-signature-256"));
  return row && secret !== null && matches ? { tenantId } : null;
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
