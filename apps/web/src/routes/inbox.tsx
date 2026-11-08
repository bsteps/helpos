import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { openTicketsQuery } from "@/api/queries.ts";
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

/** Open tickets, most recent activity first. */
export function InboxPage() {
  const tickets = useQuery(openTicketsQuery);

  return (
    <section aria-labelledby="inbox-title" className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between gap-3">
        <h1 id="inbox-title" className="font-semibold text-2xl tracking-tight">
          Inbox
        </h1>
        {tickets.data ? (
          <span className="text-muted-foreground text-sm tabular-nums">
            {tickets.data.length} open
          </span>
        ) : null}
      </div>

      {tickets.isPending ? (
        <div className="flex justify-center py-12">
          <Loader size={24} label="Loading tickets" />
        </div>
      ) : tickets.isError ? (
        <Alert variant="destructive">
          <AlertIcon />
          <AlertContent>
            <AlertDescription>
              Couldn't load the inbox. Reload the page to try again.
            </AlertDescription>
          </AlertContent>
        </Alert>
      ) : tickets.data.length === 0 ? (
        <Card variant="muted" size="compact">
          <CardHeader>
            <CardTitle>Nothing open</CardTitle>
            <CardDescription>New emails show up here.</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {tickets.data.map((ticket) => (
            <li key={ticket.id}>
              <Card interactive size="compact">
                <CardHeader>
                  <CardTitle as="h2" className="min-w-0">
                    <Link
                      to="/tickets/$id"
                      params={{ id: ticket.id }}
                      className={cn("block truncate outline-none", CARD_TARGET_CLASS)}
                    >
                      {ticket.subject || "(no subject)"}
                    </Link>
                  </CardTitle>
                  <CardDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="truncate">
                      {ticket.customer.name ?? ticket.customer.email}
                    </span>
                    <span aria-hidden>·</span>
                    <time dateTime={ticket.lastMessageAt}>
                      {formatDateTime(ticket.lastMessageAt)}
                    </time>
                    {ticket.aiPausedReason ? (
                      <AnimatedBadge status="warning" size="sm">
                        AI paused
                      </AnimatedBadge>
                    ) : null}
                    {ticket.automated ? (
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
