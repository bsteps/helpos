import { createHash, timingSafeEqual } from "node:crypto";
import { type OpenAPIHono, z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import type { Logger } from "pino";
import { apiRoute } from "../auth/access.ts";
import { type IngestDeps, ingestEmail } from "./ingest.ts";

/** Larger messages are rejected (and logged) before they are parsed or stored. */
export const maxEmailBytes = 10 * 1024 * 1024;

export interface InboundEmailDeps extends IngestDeps {
  /** Shared secret the email provider sends. When unset, every request is refused. */
  inboundSecret: string | undefined;
  logger: Pick<Logger, "info" | "warn">;
}

const errorSchema = z.object({ error: z.string() }).openapi("Error");
const resultSchema = z
  .object({
    status: z.enum(["created", "threaded", "duplicate"]),
    ticketId: z.uuid(),
    messageId: z.uuid(),
  })
  .openapi("InboundEmailResult");

const inboundEmailRoute = apiRoute({
  access: { noCaller: "The email provider proves itself with the shared inbound secret." },
  method: "post",
  path: "/v1/inbound/email",
  summary: "Receive an inbound email",
  description:
    "Called by an email provider or relay with the raw MIME message as the body. The " +
    "recipient address picks the workspace. Replies are threaded onto their ticket using " +
    "In-Reply-To and References. The content is stored as data and never acted on.",
  security: [{ inboundSecret: [] }],
  request: {
    body: {
      required: true,
      content: { "message/rfc822": { schema: z.string().openapi({ format: "binary" }) } },
    },
  },
  responses: {
    200: {
      description: "Duplicate delivery: already stored",
      content: { "application/json": { schema: resultSchema } },
    },
    201: {
      description: "Stored as a new ticket or a reply",
      content: { "application/json": { schema: resultSchema } },
    },
    401: {
      description: "Missing or wrong secret",
      content: { "application/json": { schema: errorSchema } },
    },
    404: {
      description: "No workspace has this address. Nothing was stored",
      content: { "application/json": { schema: errorSchema } },
    },
    413: {
      description: `Larger than ${maxEmailBytes} bytes`,
      content: { "application/json": { schema: errorSchema } },
    },
    422: {
      description: "Not a usable email (e.g. no From address)",
      content: { "application/json": { schema: errorSchema } },
    },
  },
});

export function registerInboundEmail(app: OpenAPIHono, deps: InboundEmailDeps): void {
  app.openAPIRegistry.registerComponent("securitySchemes", "inboundSecret", {
    type: "http",
    scheme: "bearer",
    description: "The value of HELPOS_INBOUND_SECRET.",
  });

  // Checked before the body is read, so an unauthenticated caller can't make us buffer 10 MB.
  app.use(inboundEmailRoute.path, async (c, next) => {
    if (!secretMatches(deps.inboundSecret, c.req.header("authorization"))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return next();
  });
  app.use(
    inboundEmailRoute.path,
    bodyLimit({
      maxSize: maxEmailBytes,
      onError: (c) => {
        deps.logger.warn({ limitBytes: maxEmailBytes }, "inbound email rejected: too large");
        return c.json({ error: "too_large" }, 413);
      },
    }),
  );

  app.openapi(inboundEmailRoute, async (c) => {
    const raw = new Uint8Array(await c.req.arrayBuffer());
    const result = await ingestEmail(deps, raw);
    switch (result.kind) {
      case "unroutable":
        // The same answer as any unknown address: it says nothing about other workspaces.
        return c.json({ error: "unknown_mailbox" }, 404);
      case "invalid":
        return c.json({ error: result.reason }, 422);
      case "duplicate":
        return c.json(
          { status: "duplicate" as const, ticketId: result.ticketId, messageId: result.messageId },
          200,
        );
      case "created":
        deps.logger.info(
          { ticketId: result.ticketId, threaded: result.threaded, draftReply: result.draftReply },
          "inbound email stored",
        );
        return c.json(
          {
            status: result.threaded ? ("threaded" as const) : ("created" as const),
            ticketId: result.ticketId,
            messageId: result.messageId,
          },
          201,
        );
    }
  });
}

/** Constant-time compare. Hashing first makes both sides the same length. */
export function secretMatches(
  secret: string | undefined,
  authorization: string | undefined,
): boolean {
  if (!secret || !authorization?.startsWith("Bearer ")) return false;
  const given = createHash("sha256").update(authorization.slice("Bearer ".length)).digest();
  const expected = createHash("sha256").update(secret).digest();
  return timingSafeEqual(given, expected);
}
