import { useState } from "react";
import { ApiError, type Draft } from "@/api/client.ts";
import {
  useApproveDraft,
  useCreateDraft,
  useDiscardDraft,
  useEditDraft,
  useResolveSend,
  useRetryDraft,
} from "@/api/queries.ts";
import { Textarea } from "@/components/textarea.tsx";
import {
  Alert,
  AlertContent,
  AlertDescription,
  AlertIcon,
  AlertTitle,
} from "@/components/ui/alert.tsx";
import { AnimatedBadge, type AnimatedBadgeProps } from "@/components/ui/animated-badge.tsx";
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
import { webHref } from "@/lib/web-href.ts";
import {
  type DraftView,
  draftDescription,
  draftTitle,
  liveFixNotice,
  type Meanwhile,
  newDraftError,
} from "./draft-view.ts";

const isConflict = (error: unknown) => error instanceof ApiError && error.status === 409;

const statusBadge = {
  pending: { status: "info", label: "Waiting for approval" },
  approved: { status: "loading", label: "Sending" },
  sent: { status: "success", label: "Sent" },
  send_uncertain: { status: "danger", label: "Delivery uncertain" },
  send_failed: { status: "danger", label: "Not sent" },
  discarded: { status: "neutral", label: "Discarded" },
} satisfies Record<
  Draft["status"],
  { status: NonNullable<AnimatedBadgeProps["status"]>; label: string }
>;

const chooseNote = {
  discarded: "The draft was discarded. Nothing has gone to the customer.",
  send_failed: "The reply that couldn't be sent was discarded. Nothing has gone to the customer.",
  ai_paused: "You can write the reply yourself.",
  draft_failed: "Ask the AI to try again, or write the reply yourself.",
} as const;

export function DraftPanel({
  conversationId,
  view,
  redraft,
  askAi,
  setComposing,
}: {
  conversationId: string;
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
          conversationId={conversationId}
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
                  Today's AI budget for this workspace is spent, so this conversation has no draft.
                  It resumes at midnight UTC.
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
                  The AI couldn't write a draft for this conversation: every try failed. Nothing has
                  gone to the customer.
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
      return <DraftCard key={view.draft.id} conversationId={conversationId} draft={view.draft} />;
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
  conversationId,
  meanwhile,
  done,
}: {
  conversationId: string;
  meanwhile: Meanwhile | undefined;
  done: () => void;
}) {
  const write = useCreateDraft(conversationId);
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

export function FixNotice({ conversationId, drafts }: { conversationId: string; drafts: Draft[] }) {
  const draft = liveFixNotice(drafts);
  return draft ? <DraftCard key={draft.id} conversationId={conversationId} draft={draft} /> : null;
}

function DraftCard({ conversationId, draft }: { conversationId: string; draft: Draft }) {
  const edit = useEditDraft(conversationId);
  const approve = useApproveDraft(conversationId);
  const retry = useRetryDraft(conversationId);
  const resolve = useResolveSend(conversationId);
  const uncertain = draft.status === "send_uncertain";
  const discard = useDiscardDraft(conversationId);
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(draft.body);
  const badge = statusBadge[draft.status];
  const pending = draft.status === "pending";
  const failed = draft.status === "send_failed";
  const cited = draft.sources.filter((s) => s.cited);
  const busy =
    resolve.isPending ||
    edit.isPending ||
    approve.isPending ||
    retry.isPending ||
    discard.isPending;
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
        <CardTitle as="h2">{draftTitle(draft)}</CardTitle>
        <CardDescription>{draftDescription(draft)}</CardDescription>
        <CardAction>
          <AnimatedBadge status={badge.status} size="sm">
            {badge.label}
          </AnimatedBadge>
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {uncertain ? (
          <Alert variant="warning">
            <AlertIcon />
            <AlertContent>
              <AlertTitle>This reply may already have gone out</AlertTitle>
              <AlertDescription>
                Check your mail provider before deciding. Mark sent records your confirmation. Send
                again may deliver a duplicate.
              </AlertDescription>
            </AlertContent>
          </Alert>
        ) : null}
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
              {cited.map((source) => {
                const href = source.url ? webHref(source.url) : null;
                return (
                  <li key={`${source.sourceId ?? source.title}:${source.excerpt.slice(0, 20)}`}>
                    {href ? (
                      <a
                        href={href}
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
                );
              })}
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
        {resolve.isError || retry.isError || discard.isError ? (
          <Alert variant="destructive">
            <AlertIcon />
            <AlertContent>
              <AlertDescription>
                {isConflict(resolve.error ?? retry.error ?? discard.error)
                  ? "This reply changed since you opened it. Check where it stands now."
                  : "That didn't work. Try again."}
              </AlertDescription>
            </AlertContent>
          </Alert>
        ) : null}
      </CardContent>

      {uncertain && draft.outboundMessageId ? (
        <CardFooter className="flex-wrap justify-end">
          {(["mark_sent", "send_again"] as const).map((decision) => (
            <Button
              key={decision}
              disabled={busy}
              onClick={() => {
                if (draft.outboundMessageId)
                  resolve.mutate({ id: draft.id, messageId: draft.outboundMessageId, decision });
              }}
            >
              {decision === "mark_sent" ? "Mark sent" : "Send again"}
            </Button>
          ))}
        </CardFooter>
      ) : null}
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
