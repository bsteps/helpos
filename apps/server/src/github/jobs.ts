import { defineTenantJob } from "@helpos/db";
import { z } from "zod";

/**
 * Reads a linked issue's state from GitHub and applies it, when events alone can't say it:
 * - right after linking, if GitHub couldn't be reached: an issue can close before its link is
 *   written, and that close's webhook had nothing to match;
 * - after a close and a reopen in the same second, which GitHub's times can't order.
 * Without it, a GitHub hiccup at the wrong moment would mean the customer is never told, or is
 * told it's fixed while the issue is open.
 */
export const recheckIssueJob = defineTenantJob("github.recheck-issue", { linkId: z.uuid() });
