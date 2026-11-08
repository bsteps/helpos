import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { ExternalLink, GitBranch } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { ApiError, type TicketDetail } from "@/api/client.ts";
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

function createProblem(error: unknown): string {
  if (!(error instanceof ApiError)) return "That didn't work. Try again.";
  switch (error.code) {
    case "token_rejected":
      return "GitHub refused the workspace's token: it has expired, or can't open issues in this repo. An owner needs to give it Issues read and write access, or connect a new token.";
    case "repo_not_found":
      return "GitHub says the repo doesn't exist, or the token can't see it.";
    case "github_unavailable":
      return "Couldn't reach GitHub. Nothing was created; try again.";
    case "already_linked":
      return "This ticket already has an issue.";
    case "github_outcome_unknown":
      return "GitHub didn't answer, so it isn't known whether the issue was opened. Check the repo; if it isn't there, try again in two minutes.";
    case "creation_pending":
      return "An issue for this ticket is being opened, or GitHub's answer to the last try was lost. Try again in two minutes: nothing is opened twice.";
    case "issue_not_linked":
      return "The issue was opened on GitHub, but couldn't be linked to this ticket. Find it in the repo before creating another.";
    case "reconnect_required":
      return "The stored token can't be read any more. An owner needs to connect the repo again.";
    default:
      return "That didn't work. Try again.";
  }
}

/** The ticket's GitHub issue, or the way to create one. Nothing for callers without the scope. */
export function GithubIssuePanel({ ticket }: { ticket: TicketDetail }) {
  const { me } = useRouteContext({ from: "/signed-in" });
  const canWrite = me.scopes.includes("github:write");
  const github = useQuery({ ...githubQuery, enabled: canWrite && !ticket.githubIssue });
  const [composing, setComposing] = useState(false);

  if (ticket.githubIssue) return <LinkedIssue issue={ticket.githubIssue} />;
  if (!canWrite || !github.data?.connected || !github.data.repo) return null;
  if (composing) {
    return (
      <IssueComposer
        ticketId={ticket.id}
        repo={github.data.repo}
        onDone={() => setComposing(false)}
      />
    );
  }
  return (
    <div className="flex justify-end">
      <Button variant="outline" size="sm" onClick={() => setComposing(true)}>
        <GitBranch aria-hidden className="size-4" />
        Create GitHub issue
      </Button>
    </div>
  );
}

function LinkedIssue({ issue }: { issue: NonNullable<TicketDetail["githubIssue"]> }) {
  const open = issue.state === "open";
  return (
    <Card variant="muted" size="compact">
      <CardHeader>
        <CardTitle as="h2">
          <a
            href={issue.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 underline-offset-4 hover:underline"
          >
            {issue.repo}#{issue.number}
            <ExternalLink aria-hidden className="size-3.5" />
          </a>
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
  ticketId,
  repo,
  onDone,
}: {
  ticketId: string;
  repo: string;
  onDone: () => void;
}) {
  const draft = useDraftGithubIssue(ticketId);
  const create = useCreateGithubIssue(ticketId);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  // Ask once, when the form opens (the ref survives React's dev double-mount, so the AI is
  // called once); the human edits whatever comes back.
  const asked = useRef(false);
  const { mutate: suggest } = draft;
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    suggest(undefined, {
      onSuccess: (suggestion) => {
        setTitle(suggestion.title);
        setBody(suggestion.body);
      },
    });
  }, [suggest]);

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
      {/* Idle too: the first render comes before the effect has asked. */}
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
                  <AlertTitle>No issue was created</AlertTitle>
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
