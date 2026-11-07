import { defineTenantJob } from "@helpos/db";
import { z } from "zod";

/** Enqueued when a knowledge source is added. Fetches or reads it, chunks it and embeds it. */
export const ingestSourceJob = defineTenantJob("ingest-source", { sourceId: z.uuid() });
