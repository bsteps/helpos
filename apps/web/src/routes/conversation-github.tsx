import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { ExternalLink, GitBranch } from "lucide-react";
import { type FormEvent, useState } from "react";
import { ApiError, type ConversationDetail } from "@/api/client.ts";
import { githubQuery, useCreateGithubIssue, useDraftGithubIssue } from "@/api/queries.ts";
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
import { Input } from "@/components/ui/input.tsx";
import { Loader } from "@/components/ui/loader.tsx";
import { webHref } from "@/lib/web-href.ts";

/** Why the AI couldn't draft the issue. The form still opens, empty, to write it by hand. */
function draftProblem(error: unknown): string {
  if (error instanceof ApiError && error.code === "daily_budget_reached") {
    return "Today's AI budget is spent, so there's no suggestion. Write the issue yourself.";
  }
  if (error instanceof ApiError && error.code === "ai_not_configured") {
    return "AI isn't set up on this server, so there's no suggestion. Write the issue yourself.";
  }
  return "The AI couldn't draft this issue. Write it yourself, or try again later.";
}

/** Errors after which an issue may exist on GitHub: "No issue was created" would be wrong. */
const mayHaveIssue = new Set(["github_outcome_unknown", "issue_not_linked"]);

function createProblem(error: unknown): string {
  if (!(error instanceof ApiError)) return "That didn't work. Try again.";
  switch (error.code) {
    case "token_rejected":
      return "GitHub refused the workspace's token: it has expired, or can't open issues in this repo. An owner needs to give it Issues read and write access, or connect a new token.";
    case "repo_not_found":
      return "GitHub says the repo doesn't exist, or the token can't see it.";
    case "issue_rejected":
      return "GitHub refused this issue, perhaps because it's too long. Nothing was created; shorten it and try again.";
    case "github_unavailable":
      return "Couldn't reach GitHub. Nothing was created; try again.";
    case "already_linked":
      return "This conversation already has an issue.";
    case "github_outcome_unknown":
      return "GitHub didn't answer, so it isn't known whether the issue was opened. Check the repo; if it isn't there, try again in five minutes.";
    case "creation_pending":
      return "An issue for this conversation is being opened, or GitHub's answer to the last try was lost. Try again in five minutes: nothing is opened twice.";
    case "issue_not_linked":
      return "The issue was opened on GitHub, but couldn't be linked to this conversation. Find it in the repo before creating another.";
    case "reconnect_required":
      return "The stored token can't be read any more. An owner needs to connect the repo again.";
    default:
      return "That didn't work. Try again.";
  }
}

/** The conversation's GitHub issue, or the way to create one. Nothing for callers without the scope. */
export function GithubIssuePanel({ conversation }: { conversation: ConversationDetail }) {
  const { me } = useRouteContext({ from: "/signed-in" });
  const canWrite = me.scopes.includes("github:write");
  const github = useQuery({ ...githubQuery, enabled: canWrite && !conversation.githubIssue });
  const [composing, setComposing] = useState(false);
  // Kept here, not in the form: cancelling and opening it again shows the same suggestion and
  // the edits made to it, without asking the AI (and spending its budget) again.
  const draft = useDraftGithubIssue(conversation.id);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const open = () => {
    setComposing(true);
    // Asked once per visit; again only if the last try failed.
    if (draft.isIdle || draft.isError) {
      draft.mutate(undefined, {
        onSuccess: (suggestion) => {
          setTitle(suggestion.title);
          setBody(suggestion.body);
        },
      });
    }
  };

  if (conversation.githubIssue) return <LinkedIssue issue={conversation.githubIssue} />;
  if (!canWrite || !github.data?.connected || !github.data.repo) return null;
  if (composing) {
    return (
      <IssueComposer
        conversationId={conversation.id}
        repo={github.data.repo}
        draft={draft}
        title={title}
        setTitle={setTitle}
        body={body}
        setBody={setBody}
        onDone={() => setComposing(false)}
      />
    );
  }
  return (
    <div className="flex justify-end">
      <Button variant="outline" size="sm" onClick={open}>
        <GitBranch aria-hidden className="size-4" />
        Create GitHub issue
      </Button>
    </div>
  );
}

function LinkedIssue({ issue }: { issue: NonNullable<ConversationDetail["githubIssue"]> }) {
  const open = issue.state === "open";
  const href = webHref(issue.url);
  return (
    <Card variant="muted" size="compact">
      <CardHeader>
        <CardTitle as="h2">
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 underline-offset-4 hover:underline"
            >
              {issue.repo}#{issue.number}
              <ExternalLink aria-hidden className="size-3.5" />
            </a>
          ) : (
            <span>
              {issue.repo}#{issue.number}
            </span>
          )}
        </CardTitle>
        <CardDescription>
          {open
            ? "When it's closed as done, a fix notice for the customer is drafted here."
            : "Closed on GitHub."}
        </CardDescription>
        <CardAction>
          <AnimatedBadge status={open ? "info" : "success"} size="sm">
            {open ? "Issue open" : "Issue closed"}
          </AnimatedBadge>
        </CardAction>
      </CardHeader>
    </Card>
  );
}

function IssueComposer({
  conversationId,
  repo,
  draft,
  title,
  setTitle,
  body,
  setBody,
  onDone,
}: {
  conversationId: string;
  repo: string;
  /** The AI's suggestion, asked for by the panel when the form first opened. */
  draft: ReturnType<typeof useDraftGithubIssue>;
  title: string;
  setTitle: (title: string) => void;
  body: string;
  setBody: (body: string) => void;
  onDone: () => void;
}) {
  const create = useCreateGithubIssue(conversationId);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate({ title: title.trim(), body }, { onSuccess: onDone });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">New GitHub issue</CardTitle>
        <CardDescription>
          Only this title and description are sent to {repo}: no labels, no assignees. Nothing is
          created until you confirm.
        </CardDescription>
      </CardHeader>
      {/* Idle too: the form can render before the panel's request has started. */}
      {draft.isIdle || draft.isPending ? (
        <CardContent className="flex items-center gap-3 text-muted-foreground">
          <Loader size={16} label="Drafting the issue" />
          The AI is drafting the issue…
        </CardContent>
      ) : (
        <form onSubmit={submit}>
          <CardContent className="flex flex-col gap-4">
            {draft.isError ? (
              <Alert variant="warning">
                <AlertIcon />
                <AlertContent>
                  <AlertDescription>{draftProblem(draft.error)}</AlertDescription>
                </AlertContent>
              </Alert>
            ) : (
              <p className="text-muted-foreground text-sm">
                Drafted by AI from the customer's messages. Links, email addresses and @mentions
                were left out: add back only what the team needs.
              </p>
            )}
            <Input
              label="Title"
              value={title}
              onChange={setTitle}
              maxLength={200}
              required
              disabled={create.isPending}
            />
            <Textarea
              label="Description"
              value={body}
              onChange={setBody}
              rows={12}
              disabled={create.isPending}
            />
            {create.isError ? (
              <Alert variant="destructive">
                <AlertIcon />
                <AlertContent>
                  <AlertTitle>
                    {create.error instanceof ApiError && mayHaveIssue.has(create.error.code)
                      ? "Check GitHub"
                      : "No issue was created"}
                  </AlertTitle>
                  <AlertDescription>{createProblem(create.error)}</AlertDescription>
                </AlertContent>
              </Alert>
            ) : null}
          </CardContent>
          <CardFooter className="flex-wrap justify-end">
            <Button type="button" variant="ghost" disabled={create.isPending} onClick={onDone}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || title.trim() === ""}>
              {create.isPending ? (
                <Loader size={16} label="Creating" className="text-current" />
              ) : null}
              Create issue
            </Button>
          </CardFooter>
        </form>
      )}
    </Card>
  );
}
