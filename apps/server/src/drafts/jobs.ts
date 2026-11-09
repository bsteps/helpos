import { defineTenantJob, type RetryPolicy } from "@helpos/db";
import { z } from "zod";

/** Enqueued when a person's email is stored. Drafts a reply to that one message. */
export const draftReplyJob = defineTenantJob("draft-reply", { messageId: z.uuid() });

/** Enqueued only by the approve endpoint. Sends one approved draft. */
export const sendReplyJob = defineTenantJob("send-reply", { draftId: z.uuid() });

/**
 * A failed send is tried 8 more times, 1 minute apart at first and doubling up to an hour:
 * about 3 hours in all, enough to ride out a mail server outage. After that the draft is
 * marked `send_failed`, for someone to retry or discard.
 */
export const sendReplyRetry: RetryPolicy = {
  limit: 8,
  delaySeconds: 60,
  backoff: true,
  maxDelaySeconds: 3600,
};

/** Enqueued with every new pending draft. Emails the workspace owners, at most once per window. */
export const draftNoticeJob = defineTenantJob("draft-notice", { draftId: z.uuid() });
