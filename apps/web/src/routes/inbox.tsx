import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { draftStatsQuery, openConversationsQuery } from "@/api/queries.ts";
import { Alert, AlertContent, AlertDescription, AlertIcon } from "@/components/ui/alert.tsx";
import { AnimatedBadge } from "@/components/ui/animated-badge.tsx";
import {
  CARD_TARGET_CLASS,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import { Loader } from "@/components/ui/loader.tsx";
import { formatDateTime } from "@/lib/format.ts";
import { cn } from "@/lib/utils.ts";

/** Open conversations, and closed ones whose reply couldn't be sent, most recent activity first. */
export function InboxPage() {
  const conversations = useQuery(openConversationsQuery);

  return (
    <section aria-labelledby="inbox-title" className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between gap-3">
        <h1 id="inbox-title" className="font-semibold text-2xl tracking-tight">
          Inbox
        </h1>
        {conversations.data ? (
          <span className="text-muted-foreground text-sm tabular-nums">
            {conversations.data.filter((c) => c.status === "open").length} open
          </span>
        ) : null}
      </div>
      <DraftStatsLine />

      {conversations.isPending ? (
        <div className="flex justify-center py-12">
          <Loader size={24} label="Loading conversations" />
        </div>
      ) : conversations.isError ? (
        <Alert variant="destructive">
          <AlertIcon />
          <AlertContent>
            <AlertDescription>
              Couldn't load the inbox. Reload the page to try again.
            </AlertDescription>
          </AlertContent>
        </Alert>
      ) : conversations.data.length === 0 ? (
        <Card variant="muted" size="compact">
          <CardHeader>
            <CardTitle>Nothing open</CardTitle>
            <CardDescription>New emails show up here.</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {conversations.data.map((conversation) => (
            <li key={conversation.id}>
              <Card interactive size="compact">
                <CardHeader>
                  <CardTitle as="h2" className="min-w-0">
                    <Link
                      to="/conversations/$id"
                      params={{ id: conversation.id }}
                      className={cn("block truncate outline-none", CARD_TARGET_CLASS)}
                    >
                      {conversation.subject || "(no subject)"}
                    </Link>
                  </CardTitle>
                  <CardDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="truncate">
                      {conversation.customer.name ?? conversation.customer.email}
                    </span>
                    <span aria-hidden>·</span>
                    <time dateTime={conversation.lastMessageAt}>
                      {formatDateTime(conversation.lastMessageAt)}
                    </time>
                    {conversation.replyNotSent ? (
                      <AnimatedBadge status="danger" size="sm">
                        Reply needs attention
                      </AnimatedBadge>
                    ) : null}
                    {conversation.status === "closed" ? (
                      <AnimatedBadge status="neutral" size="sm">
                        Closed
                      </AnimatedBadge>
                    ) : null}
                    {conversation.aiPausedReason ? (
                      <AnimatedBadge status="warning" size="sm">
                        {conversation.aiPausedReason === "draft_failed"
                          ? "No AI draft"
                          : "AI paused"}
                      </AnimatedBadge>
                    ) : null}
                    {conversation.automated ? (
                      <AnimatedBadge status="neutral" size="sm">
                        Automated
                      </AnimatedBadge>
                    ) : null}
                  </CardDescription>
                </CardHeader>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const statsDays = 14;

/**
 * The MVP's yardstick: how often the AI's draft went out exactly as written. Says nothing while
 * loading or on error, so the inbox never waits on it.
 */
function DraftStatsLine() {
  const stats = useQuery(draftStatsQuery(statsDays));
  if (!stats.data) return null;
  const { approvedUnchanged, approvedEdited, unchangedRate } = stats.data;
  const approved = approvedUnchanged + approvedEdited;
  // Of approved drafts only: one still pending or discarded never reached a customer.
  return (
    <p className="text-muted-foreground text-sm tabular-nums">
      Last {statsDays} days:{" "}
      {unchangedRate === null
        ? "no drafts approved yet"
        : `${Math.round(unchangedRate * 100)}% of drafts approved unchanged (${approvedUnchanged} of ${approved})`}
    </p>
  );
}
