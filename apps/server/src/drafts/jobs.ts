import { defineTenantJob } from "@helpos/db";
import { z } from "zod";

/** Enqueued when a person's email is stored. Drafts a reply to that one message. */
export const draftReplyJob = defineTenantJob("draft-reply", { messageId: z.uuid() });

/** Enqueued only by the approve endpoint. Sends one approved draft. */
export const sendReplyJob = defineTenantJob("send-reply", { draftId: z.uuid() });

/** Enqueued with every new pending draft. Emails the workspace owners, at most once per window. */
export const draftNoticeJob = defineTenantJob("draft-notice", { draftId: z.uuid() });
