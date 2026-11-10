import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft, CircleCheck } from "lucide-react";
import { useState } from "react";
import { ApiError, type Draft, type Message } from "@/api/client.ts";
import {
  draftsQuery,
  keys,
  ticketQuery,
  useApproveDraft,
  useCloseTicket,
  useCreateDraft,
  useDiscardDraft,
  useEditDraft,
  useRetryDraft,
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
import {
  type Ask,
  type DraftView,
  draftView,
  liveFixNotice,
  type Meanwhile,
  newDraftError,
  newestReply,
  waitingOn,
} from "./draft-view.ts";
import { GithubIssuePanel } from "./ticket-github.tsx";

const isConflict = (error: unknown) => error instanceof ApiError && error.status === 409;

export function TicketPage() {
  const { id } = useParams({ from: "/signed-in/tickets/$id" });
  // Keyed, so a reply being written on one ticket doesn't follow you to the next.
  return <Ticket key={id} id={id} />;
}

function Ticket({ id }: { id: string }) {
  const queryClient = useQueryClient();
  // Up here, not in the cards: whether a new draft was asked for decides the polling, and a
  // reply being written must survive a draft arriving meanwhile.
  const redraft = useCreateDraft(id);
  const [ask, setAsk] = useState<Ask>();
  const [composing, setComposing] = useState(false);
  const ticket = useQuery({
    ...ticketQuery(id),
    // The AI giving up shows only on the ticket (`draft_failed`), not in the drafts: while a
    // draft is awaited, look at the ticket again too.
    refetchInterval: (query) =>
      waitingOn(query.state.data, ask)(queryClient.getQueryData(keys.drafts(id)) ?? [])
        ? 2_000
        : false,
  });
  const drafts = useQuery(draftsQuery(id, waitingOn(ticket.data, ask)));
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
          <DraftPanel
            ticketId={t.id}
            view={draftView(t, drafts.data, ask, composing)}
            redraft={redraft}
            askAi={() => {
              const replacing = newestReply(drafts.data)?.id ?? null;
              setAsk({ replacing });
              redraft.mutate(
                { regenerate: true },
                {
                  onError: () => setAsk(undefined),
                  onSuccess: async () => {
                    // The server cleared the old `draft_failed`: with the ticket fetched again, a
                    // `draft_failed` that shows up later is this ask failing too.
                    await queryClient.invalidateQueries({ queryKey: keys.ticket(id) });
                    setAsk((now) =>
                      now?.replacing === replacing ? { replacing, queued: true } : now,
                    );
                  },
                },
              );
            }}
            setComposing={setComposing}
          />
        )}
      </section>

      {drafts.data && liveFixNotice(drafts.data) ? (
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
  send_failed: { status: "danger", label: "Not sent" },
  discarded: { status: "neutral", label: "Discarded" },
} as const;

const chooseNote = {
  discarded: "The draft was discarded. Nothing has gone to the customer.",
  send_failed: "The reply that couldn't be sent was discarded. Nothing has gone to the customer.",
  ai_paused: "You can write the reply yourself.",
  draft_failed: "Ask the AI to try again, or write the reply yourself.",
} as const;

function DraftPanel({
  ticketId,
  view,
  redraft,
  askAi,
  setComposing,
}: {
  ticketId: string;
  view: DraftView;
  redraft: ReturnType<typeof useCreateDraft>;
  askAi: () => void;
  setComposing: (composing: boolean) => void;
}) {
  switch (view.kind) {
    case "none":
      return null;
    case "writing":
      return (
        <Card variant="muted" size="compact">
          <CardContent className="flex flex-wrap items-center gap-3 text-muted-foreground">
            <Loader size={16} label="Waiting for the draft" />
            The AI is writing a draft…
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => setComposing(true)}
            >
              Write my own instead
            </Button>
          </CardContent>
        </Card>
      );
    case "compose":
      return (
        <Composer
          ticketId={ticketId}
          meanwhile={view.meanwhile}
          done={() => {
            setComposing(false);
            // An old refusal shouldn't greet the person next time; a request in flight keeps its.
            if (!redraft.isPending) redraft.reset();
          }}
        />
      );
    case "choose":
      return (
        <>
          {view.after === "ai_paused" ? (
            <Alert variant="warning">
              <AlertIcon />
              <AlertContent>
                <AlertTitle>AI paused</AlertTitle>
                <AlertDescription>
                  Today's AI budget for this workspace is spent, so this ticket has no draft. It
                  resumes at midnight UTC.
                </AlertDescription>
              </AlertContent>
            </Alert>
          ) : null}
          {view.after === "draft_failed" ? (
            <Alert variant="warning">
              <AlertIcon />
              <AlertContent>
                <AlertTitle>No AI draft</AlertTitle>
                <AlertDescription>
                  The AI couldn't write a draft for this ticket: every try failed. Nothing has gone
                  to the customer.
                </AlertDescription>
              </AlertContent>
            </Alert>
          ) : null}
          <Card variant="muted" size="compact">
            <CardContent className="flex flex-col gap-3">
              <p className="text-muted-foreground">{chooseNote[view.after]}</p>
              {redraft.isError ? <NewDraftError error={redraft.error} /> : null}
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    redraft.reset();
                    setComposing(true);
                  }}
                >
                  Write my own
                </Button>
                <Button onClick={askAi}>Ask the AI for a draft</Button>
              </div>
            </CardContent>
          </Card>
        </>
      );
    case "draft":
      // Keyed by draft only: a refetched body must not remount the card, or an approval refused
      // because the text changed would lose its "this draft changed" message (and any typed text).
      return <DraftCard key={view.draft.id} ticketId={ticketId} draft={view.draft} />;
  }
}

function NewDraftError({ error }: { error: Error }) {
  return (
    <Alert variant="destructive">
      <AlertIcon />
      <AlertContent>
        <AlertDescription>
          {newDraftError(error instanceof ApiError ? error.code : undefined)}
        </AlertDescription>
      </AlertContent>
    </Alert>
  );
}

const meanwhileNote = {
  drafted: "A draft arrived while you were writing. Saving yours replaces it. Cancel to see it.",
  answered:
    "A reply was approved while you were writing, so yours can't be saved. Cancel to see it.",
  send_failed:
    "A reply was approved but couldn't be sent, so yours can't be saved. Cancel, then retry or discard it.",
} as const;

function Composer({
  ticketId,
  meanwhile,
  done,
}: {
  ticketId: string;
  meanwhile: Meanwhile | undefined;
  done: () => void;
}) {
  const write = useCreateDraft(ticketId);
  const [body, setBody] = useState("");
  return (
    <Card variant="muted" size="compact">
      <CardContent className="flex flex-col gap-3">
        {meanwhile && !write.isPending ? (
          <p className="text-muted-foreground">{meanwhileNote[meanwhile]}</p>
        ) : null}
        <Textarea
          label="Your reply"
          value={body}
          onChange={setBody}
          disabled={write.isPending}
          rows={8}
        />
        {write.isError ? <NewDraftError error={write.error} /> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" disabled={write.isPending} onClick={done}>
            Cancel
          </Button>
          <Button
            disabled={
              write.isPending ||
              body.trim() === "" ||
              (meanwhile !== undefined && meanwhile !== "drafted")
            }
            onClick={() => write.mutate({ body }, { onSuccess: done })}
          >
            {write.isPending ? <Loader size={16} label="Saving" className="text-current" /> : null}
            Save draft
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function FixNotice({ ticketId, drafts }: { ticketId: string; drafts: Draft[] }) {
  const draft = liveFixNotice(drafts);
  return draft ? <DraftCard key={draft.id} ticketId={ticketId} draft={draft} /> : null;
}

function DraftCard({ ticketId, draft }: { ticketId: string; draft: Draft }) {
  const edit = useEditDraft(ticketId);
  const approve = useApproveDraft(ticketId);
  const retry = useRetryDraft(ticketId);
  const discard = useDiscardDraft(ticketId);
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(draft.body);
  const badge = statusBadge[draft.status];
  const pending = draft.status === "pending";
  const failed = draft.status === "send_failed";
  const cited = draft.sources.filter((s) => s.cited);
  const busy = edit.isPending || approve.isPending || retry.isPending || discard.isPending;
  const fixed = draft.kind === "fixed";

  const discardButton = (variant: "outline" | "ghost") => (
    <Button variant={variant} disabled={busy} onClick={() => discard.mutate(draft.id)}>
      {discard.isPending ? <Loader size={16} label="Discarding" className="text-current" /> : null}
      Discard
    </Button>
  );
  const save = () => edit.mutate({ id: draft.id, body }, { onSuccess: () => setEditing(false) });

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">{fixed ? "Fix notice" : pending ? "Draft" : "Reply"}</CardTitle>
        <CardDescription>
          {draft.sentAt
            ? `Sent ${formatDateTime(draft.sentAt)}`
            : pending
              ? fixed
                ? "The GitHub issue was closed as done. Nothing is sent until you approve it."
                : "Nothing is sent until you approve it."
              : failed
                ? "Approved, but it couldn't be sent."
                : "Approved. It goes out in a moment."}
        </CardDescription>
        <CardAction>
          <AnimatedBadge status={badge.status} size="sm">
            {badge.label}
          </AnimatedBadge>
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {failed ? (
          <Alert variant="destructive" data-testid="send-failed-alert">
            <AlertIcon />
            <AlertContent>
              <AlertTitle>This reply wasn't sent</AlertTitle>
              <AlertDescription>
                Every attempt to send it failed, most likely because the mail server couldn't be
                reached. Retry it to send the same reply again, or discard it to write a new one.
              </AlertDescription>
            </AlertContent>
          </Alert>
        ) : null}
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
        {retry.isError || discard.isError ? (
          <Alert variant="destructive">
            <AlertIcon />
            <AlertContent>
              <AlertDescription>
                {isConflict(retry.error ?? discard.error)
                  ? "This reply changed since you opened it. Check where it stands now."
                  : "That didn't work. Try again."}
              </AlertDescription>
            </AlertContent>
          </Alert>
        ) : null}
      </CardContent>

      {failed ? (
        <CardFooter className="flex-wrap justify-end">
          {discardButton("outline")}
          <Button disabled={busy} onClick={() => retry.mutate(draft.id)}>
            {retry.isPending ? (
              <Loader size={16} label="Retrying" className="text-current" />
            ) : null}
            Retry send
          </Button>
        </CardFooter>
      ) : null}

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
              {discardButton("ghost")}
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
