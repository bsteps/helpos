import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import { ApiError, type Draft, type Message, type TicketDetail } from "@/api/client.ts";
import {
  draftsQuery,
  ticketQuery,
  useApproveDraft,
  useCloseTicket,
  useEditDraft,
} from "@/api/queries.ts";
import { EmailFrame } from "@/components/email-frame.tsx";
import { Textarea } from "@/components/textarea.tsx";
import {
  Alert,
  AlertContent,
  AlertDescription,
  AlertIcon,
  AlertTitle,
} from "@/components/ui/alert.tsx";
import { AnimatedBadge } from "@/components/ui/animated-badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import { Loader } from "@/components/ui/loader.tsx";
import { formatDateTime } from "@/lib/format.ts";

const isConflict = (error: unknown) => error instanceof ApiError && error.status === 409;

/** The draft that matters now: the newest one that wasn't thrown away. */
function liveDraft(drafts: Draft[]): Draft | undefined {
  return drafts.filter((d) => d.status !== "discarded").at(-1);
}

/** Whether to keep checking for a draft: one is being written, or an approved one is sending. */
function waitingOn(ticket: TicketDetail | undefined) {
  return (drafts: Draft[]): boolean => {
    if (ticket?.status !== "open") return false;
    const live = liveDraft(drafts);
    if (live) return live.status === "approved";
    return !ticket.automated && !ticket.aiPausedReason;
  };
}

export function TicketPage() {
  const { id } = useParams({ from: "/signed-in/tickets/$id" });
  const ticket = useQuery(ticketQuery(id));
  const drafts = useQuery(draftsQuery(id, waitingOn(ticket.data)));
  const close = useCloseTicket(id);

  if (ticket.isPending) {
    return (
      <div className="flex justify-center py-12">
        <Loader size={24} label="Loading ticket" />
      </div>
    );
  }
  if (ticket.isError) {
    const missing = ticket.error instanceof ApiError && ticket.error.status === 404;
    return (
      <Alert variant="destructive">
        <AlertIcon />
        <AlertContent>
          <AlertDescription>
            {missing ? "This ticket doesn't exist in your workspace." : "Couldn't load the ticket."}{" "}
            <Link to="/">Back to the inbox</Link>
          </AlertDescription>
        </AlertContent>
      </Alert>
    );
  }

  const t = ticket.data;
  return (
    <article aria-labelledby="ticket-subject" className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Link
          to="/"
          className="inline-flex w-fit items-center gap-1.5 text-muted-foreground text-sm hover:text-foreground"
        >
          <ArrowLeft aria-hidden className="size-3.5" />
          Inbox
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 id="ticket-subject" className="break-words font-semibold text-2xl tracking-tight">
              {t.subject || "(no subject)"}
            </h1>
            <p className="text-muted-foreground text-sm">
              {t.customer.name ? `${t.customer.name} · ` : ""}
              {t.customer.email}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <AnimatedBadge status={t.status === "open" ? "info" : "neutral"} size="sm">
              {t.status === "open" ? "Open" : "Closed"}
            </AnimatedBadge>
            {t.status === "open" ? (
              <Button
                variant="outline"
                size="sm"
                disabled={close.isPending}
                onClick={() => close.mutate()}
              >
                Close
              </Button>
            ) : null}
          </div>
        </div>
        {close.isError ? (
          <Alert variant="destructive">
            <AlertIcon />
            <AlertContent>
              <AlertDescription>Couldn't close the ticket. Try again.</AlertDescription>
            </AlertContent>
          </Alert>
        ) : null}
      </div>

      <section aria-label="Conversation" className="flex flex-col gap-3">
        {t.messages.map((message) => (
          <MessageCard key={message.id} message={message} />
        ))}
      </section>

      <section aria-label="Draft" className="flex flex-col gap-3">
        {drafts.isPending ? null : drafts.isError ? (
          <Alert variant="destructive">
            <AlertIcon />
            <AlertContent>
              <AlertDescription>Couldn't load the draft.</AlertDescription>
            </AlertContent>
          </Alert>
        ) : (
          <DraftPanel ticket={t} draft={liveDraft(drafts.data)} />
        )}
      </section>
    </article>
  );
}

function MessageCard({ message }: { message: Message }) {
  const inbound = message.direction === "inbound";
  const sender = message.from.name
    ? `${message.from.name} <${message.from.address}>`
    : message.from.address;
  return (
    <Card variant={inbound ? "outlined" : "muted"} size="compact">
      <CardHeader>
        <CardTitle className="truncate">{sender}</CardTitle>
        <CardDescription>
          {inbound ? "Customer" : "Reply"} ·{" "}
          <time dateTime={message.createdAt}>{formatDateTime(message.createdAt)}</time>
        </CardDescription>
      </CardHeader>
      <CardContent>
        {message.html ? (
          <EmailFrame html={message.html} title={`Email from ${message.from.address}`} />
        ) : (
          <p className="whitespace-pre-wrap break-words leading-relaxed">{message.text}</p>
        )}
      </CardContent>
    </Card>
  );
}

const statusBadge = {
  pending: { status: "info", label: "Waiting for approval" },
  approved: { status: "loading", label: "Sending" },
  sent: { status: "success", label: "Sent" },
  discarded: { status: "neutral", label: "Discarded" },
} as const;

function DraftPanel({ ticket, draft }: { ticket: TicketDetail; draft: Draft | undefined }) {
  if (!draft) {
    if (ticket.status !== "open" || ticket.automated) return null;
    if (ticket.aiPausedReason) {
      return (
        <Alert variant="warning">
          <AlertIcon />
          <AlertContent>
            <AlertTitle>AI paused</AlertTitle>
            <AlertDescription>
              Today's AI budget for this workspace is spent, so this ticket has no draft. It resumes
              at midnight UTC.
            </AlertDescription>
          </AlertContent>
        </Alert>
      );
    }
    return (
      <Card variant="muted" size="compact">
        <CardContent className="flex items-center gap-3 text-muted-foreground">
          <Loader size={16} label="Waiting for the draft" />
          The AI is writing a draft…
        </CardContent>
      </Card>
    );
  }
  // Keyed by draft and body, so an edit someone else saved resets this one's editor.
  return <DraftCard key={`${draft.id}:${draft.updatedAt}`} ticketId={ticket.id} draft={draft} />;
}

function DraftCard({ ticketId, draft }: { ticketId: string; draft: Draft }) {
  const edit = useEditDraft(ticketId);
  const approve = useApproveDraft(ticketId);
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(draft.body);
  const badge = statusBadge[draft.status];
  const pending = draft.status === "pending";
  const cited = draft.sources.filter((s) => s.cited);
  const busy = edit.isPending || approve.isPending;

  const save = () => edit.mutate({ id: draft.id, body }, { onSuccess: () => setEditing(false) });

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">{pending ? "AI draft" : "Reply"}</CardTitle>
        <CardDescription>
          {draft.sentAt
            ? `Sent ${formatDateTime(draft.sentAt)}`
            : pending
              ? "Nothing is sent until you approve it."
              : "Approved. It goes out in a moment."}
        </CardDescription>
        <CardAction>
          <AnimatedBadge status={badge.status} size="sm">
            {badge.label}
          </AnimatedBadge>
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {pending && draft.internalKnowledge ? (
          <Alert variant="warning">
            <AlertIcon />
            <AlertContent>
              <AlertDescription>
                This draft was written with your team's internal notes. Check it doesn't reveal them
                before you send it.
              </AlertDescription>
            </AlertContent>
          </Alert>
        ) : null}

        {editing ? (
          <Textarea
            label="Reply"
            value={body}
            onChange={setBody}
            disabled={edit.isPending}
            error={body.trim() === "" ? "The reply can't be empty." : undefined}
            rows={10}
          />
        ) : (
          <p data-testid="draft-body" className="whitespace-pre-wrap break-words leading-relaxed">
            {draft.body}
          </p>
        )}

        {cited.length > 0 && !editing ? (
          <div className="flex flex-col gap-1">
            <p className="text-muted-foreground text-xs">Written from</p>
            <ul className="flex flex-col gap-0.5 text-sm">
              {cited.map((source) => (
                <li key={`${source.sourceId ?? source.title}:${source.excerpt.slice(0, 20)}`}>
                  {source.url && /^https?:\/\//i.test(source.url) ? (
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline underline-offset-4"
                    >
                      {source.title}
                    </a>
                  ) : (
                    source.title
                  )}
                  {source.visibility === "internal" ? (
                    <span className="text-muted-foreground"> (internal)</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {edit.isError || approve.isError ? (
          <Alert variant="destructive">
            <AlertIcon />
            <AlertContent>
              <AlertDescription>
                {isConflict(edit.error ?? approve.error)
                  ? "This draft changed since you opened it. Read it again before approving."
                  : "That didn't work. Try again."}
              </AlertDescription>
            </AlertContent>
          </Alert>
        ) : null}
      </CardContent>

      {pending ? (
        <CardFooter className="flex-wrap justify-end">
          {editing ? (
            <>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setBody(draft.body);
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
              <Button disabled={busy || body.trim() === ""} onClick={save}>
                Save
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" disabled={busy} onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button
                disabled={busy}
                onClick={() => approve.mutate({ id: draft.id, body: draft.body })}
              >
                {approve.isPending ? (
                  <Loader size={16} label="Approving" className="text-current" />
                ) : null}
                Approve &amp; send
              </Button>
            </>
          )}
        </CardFooter>
      ) : null}
    </Card>
  );
}
