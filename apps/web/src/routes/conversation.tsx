import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft, CircleCheck } from "lucide-react";
import { useState } from "react";
import { ApiError, type Message } from "@/api/client.ts";
import {
  conversationQuery,
  draftsQuery,
  keys,
  useCloseConversation,
  useCreateDraft,
} from "@/api/queries.ts";
import { EmailFrame } from "@/components/email-frame.tsx";
import { Alert, AlertContent, AlertDescription, AlertIcon } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import { Loader } from "@/components/ui/loader.tsx";
import { formatDateTime } from "@/lib/format.ts";
import { DraftPanel, FixNotice } from "./conversation-drafts.tsx";
import { GithubIssuePanel } from "./conversation-github.tsx";
import { type Ask, draftView, liveFixNotice, newestReply, waitingOn } from "./draft-view.ts";

export function ConversationPage() {
  const { id } = useParams({ from: "/signed-in/conversations/$id" });
  // Keyed, so a reply being written on one conversation doesn't follow you to the next.
  return <Conversation key={id} id={id} />;
}

function Conversation({ id }: { id: string }) {
  const queryClient = useQueryClient();
  // Up here, not in the cards: whether a new draft was asked for decides the polling, and a
  // reply being written must survive a draft arriving meanwhile.
  const redraft = useCreateDraft(id);
  const [ask, setAsk] = useState<Ask>();
  const [composing, setComposing] = useState(false);
  const conversation = useQuery({
    ...conversationQuery(id),
    // The AI giving up shows only on the conversation (`draft_failed`), not in the drafts: while a
    // draft is awaited, look at the conversation again too.
    refetchInterval: (query) =>
      waitingOn(query.state.data, ask)(queryClient.getQueryData(keys.drafts(id)) ?? [])
        ? 2_000
        : false,
  });
  const drafts = useQuery(draftsQuery(id, waitingOn(conversation.data, ask)));
  const close = useCloseConversation(id);

  if (conversation.isPending) {
    return (
      <div className="flex justify-center py-12">
        <Loader size={24} label="Loading conversation" />
      </div>
    );
  }
  if (conversation.isError) {
    const missing = conversation.error instanceof ApiError && conversation.error.status === 404;
    return (
      <Alert variant="destructive">
        <AlertIcon />
        <AlertContent>
          <AlertDescription>
            {missing
              ? "This conversation doesn't exist in your workspace."
              : "Couldn't load the conversation."}{" "}
            <Link to="/">Back to the inbox</Link>
          </AlertDescription>
        </AlertContent>
      </Alert>
    );
  }

  const c = conversation.data;
  return (
    <article aria-labelledby="conversation-subject" className="flex flex-col gap-6">
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
            <h1
              id="conversation-subject"
              className="break-words font-semibold text-2xl tracking-tight"
            >
              {c.subject || "(no subject)"}
            </h1>
            {/* Status sits with the conversation's details, away from the button, so the two don't
                read as an Open/Close pair of buttons. */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-sm">
              <span>
                {c.customer.name ? `${c.customer.name} · ` : ""}
                {c.customer.email}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden
                  className={
                    c.status === "open"
                      ? "size-2 rounded-full bg-emerald-500"
                      : "size-2 rounded-full bg-muted-foreground/50"
                  }
                />
                {c.status === "open" ? "Open" : "Closed"}
              </span>
            </div>
          </div>
          {c.status === "open" ? (
            <Button
              variant="outline"
              size="sm"
              disabled={close.isPending}
              onClick={() => close.mutate()}
            >
              <CircleCheck aria-hidden className="size-4" />
              Close conversation
            </Button>
          ) : null}
        </div>
        {close.isError ? (
          <Alert variant="destructive">
            <AlertIcon />
            <AlertContent>
              <AlertDescription>Couldn't close the conversation. Try again.</AlertDescription>
            </AlertContent>
          </Alert>
        ) : null}
      </div>

      <section aria-label="Conversation" className="flex flex-col gap-3">
        {c.messages.map((message) => (
          <MessageCard key={message.id} message={message} />
        ))}
      </section>

      <section aria-label="GitHub issue" className="flex flex-col gap-3">
        <GithubIssuePanel key={c.id} conversation={c} />
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
            conversationId={c.id}
            view={draftView(c, drafts.data, ask, composing)}
            redraft={redraft}
            askAi={() => {
              const replacing = newestReply(drafts.data)?.id ?? null;
              setAsk({ replacing });
              redraft.mutate(
                { regenerate: true },
                {
                  onError: () => setAsk(undefined),
                  onSuccess: async () => {
                    // The server cleared the old `draft_failed`: with the conversation fetched again, a
                    // `draft_failed` that shows up later is this ask failing too.
                    await queryClient.invalidateQueries({ queryKey: keys.conversation(id) });
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
          <FixNotice conversationId={c.id} drafts={drafts.data} />
        </section>
      ) : null}
    </article>
  );
}

function MessageCard({ message }: { message: Message }) {
  const [formatted, setFormatted] = useState(false);
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
          <p className="mb-2 text-muted-foreground text-xs">
            AI drafts read this text within their input limits. The formatted email may differ.
          </p>
        ) : null}
        <p className="whitespace-pre-wrap break-words leading-relaxed" data-testid="message-text">
          {message.text}
        </p>
        {message.html ? (
          <details
            className="mt-3 border-t"
            onToggle={(event) => setFormatted(event.currentTarget.open)}
          >
            <summary className="cursor-pointer py-3 text-muted-foreground text-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
              Formatted email
            </summary>
            {formatted ? (
              <EmailFrame html={message.html} title={`Email from ${message.from.address}`} />
            ) : null}
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}
