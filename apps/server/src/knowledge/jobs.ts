import { defineTenantJob } from "@helpos/db";
import { z } from "zod";

/**
 * Enqueued when a knowledge source is added. Fetches or reads it, chunks it and embeds it.
 * `requests` is the source's `ingestRequests` when the job was queued: if the job gives up after
 * a newer request came in, the give-up must not fail the source, because that request is
 * waiting for its own run.
 */
export const ingestSourceJob = defineTenantJob(
  "ingest-source",
  { sourceId: z.uuid() },
  { requests: z.number().int().nonnegative() },
);
