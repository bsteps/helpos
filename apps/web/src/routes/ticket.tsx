import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft, CircleCheck } from "lucide-react";
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
import { GithubIssuePanel } from "./ticket-github.tsx";

const isConflict = (error: unknown) => error instanceof ApiError && error.status === 409;

/**
 * The draft of a kind that matters now: the newest one that wasn't thrown away. A reply and a
 * "fixed" notice are separate: one doesn't hide or replace the other.
 */
function liveDraft(drafts: Draft[], kind: Draft["kind"] = "reply"): Draft | undefined {
  return drafts.filter((d) => d.kind === kind && d.status !== "discarded").at(-1);
}

/** Whether to keep checking for a draft: one is being written, or an approved one is sending. */
function waitingOn(ticket: TicketDetail | undefined) {
  return (drafts: Draft[]): boolean => {
    // An approved draft still goes out after the ticket is closed: keep watching until it's sent.
    if (drafts.some((d) => d.status === "approved")) return true;
    const live = liveDraft(drafts);
    if (live || ticket?.status !== "open") return false;
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
            {/* Status sits with the ticket's details, away from the button, so the two don't
                read as an Open/Close pair of buttons. */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-sm">
              <span>
                {t.customer.name ? `${t.customer.name} · ` : ""}
                {t.customer.email}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden
                  className={
                    t.status === "open"
                      ? "size-2 rounded-full bg-emerald-500"
                      : "size-2 rounded-full bg-muted-foreground/50"
                  }
                />
                {t.status === "open" ? "Open" : "Closed"}
              </span>
            </div>
          </div>
          {t.status === "open" ? (
            <Button
              variant="outline"
              size="sm"
              disabled={close.isPending}
              onClick={() => close.mutate()}
            >
              <CircleCheck aria-hidden className="size-4" />
              Close ticket
            </Button>
          ) : null}
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

      <section aria-label="GitHub issue" className="flex flex-col gap-3">
        <GithubIssuePanel key={t.id} ticket={t} />
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

      {drafts.data && liveDraft(drafts.data, "fixed") ? (
        <section aria-label="Fix notice" className="flex flex-col gap-3">
          <FixNotice ticketId={t.id} drafts={drafts.data} />
        </section>
      ) : null}
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
  // Keyed by draft only: a refetched body must not remount the card, or an approval refused
  // because the text changed would lose its "this draft changed" message (and any typed text).
  return <DraftCard key={draft.id} ticketId={ticket.id} draft={draft} />;
}

function FixNotice({ ticketId, drafts }: { ticketId: string; drafts: Draft[] }) {
  const draft = liveDraft(drafts, "fixed");
  return draft ? <DraftCard key={draft.id} ticketId={ticketId} draft={draft} /> : null;
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
  const fixed = draft.kind === "fixed";

  const save = () => edit.mutate({ id: draft.id, body }, { onSuccess: () => setEditing(false) });

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">{fixed ? "Fix notice" : pending ? "AI draft" : "Reply"}</CardTitle>
        <CardDescription>
          {draft.sentAt
            ? `Sent ${formatDateTime(draft.sentAt)}`
            : pending
              ? fixed
                ? "The GitHub issue was closed as done. Nothing is sent until you approve it."
                : "Nothing is sent until you approve it."
              : "Approved. It goes out in a moment."}
        </CardDescription>
        <CardAction>
          <AnimatedBadge status={badge.status} size="sm">
            {badge.label}
          </AnimatedBadge>
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {pending && draft.quotesInternalNote ? (
          <Alert variant="destructive" data-testid="internal-quote-alert">
            <AlertIcon />
            <AlertContent>
              <AlertTitle>This draft quotes an internal note</AlertTitle>
              <AlertDescription>
                Part of it repeats one of your team's internal notes word for word. Edit that part
                out before you send it.
              </AlertDescription>
            </AlertContent>
          </Alert>
        ) : pending && draft.internalKnowledge ? (
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
            label={fixed ? "Fix notice" : "Reply"}
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
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  // Start from the text shown now, which may have changed since the card mounted.
                  setBody(draft.body);
                  setEditing(true);
                }}
              >
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
