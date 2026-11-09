import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { ApiError, type KnowledgeSource } from "@/api/client.ts";
import {
  knowledgeSourcesQuery,
  useAddKnowledgeSource,
  useDeleteKnowledgeSource,
  useEditKnowledgeSource,
  useReingestKnowledgeSource,
} from "@/api/queries.ts";
import { Select } from "@/components/select.tsx";
import { Textarea } from "@/components/textarea.tsx";
import {
  Alert,
  AlertAction,
  AlertContent,
  AlertDescription,
  AlertIcon,
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
import { knowledgeErrorMessage } from "@/lib/knowledge.ts";

type Visibility = KnowledgeSource["visibility"];

export function KnowledgePage() {
  const { me } = useRouteContext({ from: "/signed-in" });
  const canWrite = me.scopes.includes("knowledge:write");
  const sources = useQuery(knowledgeSourcesQuery);
  const [adding, setAdding] = useState(false);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-3">
          <h1 className="font-semibold text-2xl tracking-tight">Knowledge</h1>
          {canWrite && !adding ? (
            <Button size="sm" onClick={() => setAdding(true)}>
              Add a source
            </Button>
          ) : null}
        </div>
        <p className="text-muted-foreground text-sm">
          The pages and notes AI drafts quote from. Public sources may be shown to customers;
          internal ones guide the AI but are never revealed.
        </p>
      </div>

      {canWrite && adding ? <AddSource onDone={() => setAdding(false)} /> : null}

      {sources.isPending ? <Loader size={16} label="Loading" /> : null}
      {sources.isError ? (
        <Alert variant={sources.data ? "warning" : "destructive"}>
          <AlertIcon />
          <AlertContent>
            <AlertDescription>
              {sources.data
                ? "Couldn't refresh the knowledge sources, so this list may be out of date."
                : "Couldn't load the knowledge sources."}
            </AlertDescription>
          </AlertContent>
          <AlertAction>
            <Button
              variant="ghost"
              size="sm"
              disabled={sources.isFetching}
              onClick={() => void sources.refetch()}
            >
              {sources.isFetching ? (
                <Loader size={16} label="Loading" className="text-current" />
              ) : null}
              Try again
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
      {sources.data?.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {canWrite
            ? "No sources yet. Add a help page or a note, and AI drafts start quoting it."
            : "No sources yet. A workspace owner can add them."}
        </p>
      ) : null}
      {sources.data && sources.data.length > 0 ? (
        <ul aria-label="Knowledge sources" className="flex flex-col gap-3">
          {sources.data.map((source) => (
            <li key={source.id}>
              <SourceCard source={source} canWrite={canWrite} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const visibilityOptions = [
  { value: "internal", label: "Internal: for the AI only" },
  { value: "public", label: "Public: may be shown to customers" },
] as const;

/** Why a change didn't happen, in words that say whether trying again can help. */
function problem(error: unknown, failed: string, invalid = `${failed} Try again.`): string {
  if (!(error instanceof ApiError)) {
    return `${failed} Something went wrong. Check your connection, then try again or reload the page.`;
  }
  switch (error.code) {
    case "url_taken":
      return "There's already a source for this URL.";
    case "slug_taken":
      return "There's already a source with this title.";
    case "managed_in_git":
      return `${failed} It's managed in the workspace's git repo now.`;
  }
  if (error.status === 404) return `${failed} It was deleted.`;
  if (error.code === "forbidden") return `${failed} Your account can't change knowledge sources.`;
  if (error.status === 403) return `${failed} Reload the page, then try again.`;
  if (error.status === 400) return invalid;
  return `${failed} Try again.`;
}

/** A form's error is about what was sent, so it goes once any field changes. */
function afterReset<T>(reset: () => void, set: (value: T) => void) {
  return (value: T) => {
    reset();
    set(value);
  };
}

function AddSource({ onDone }: { onDone: () => void }) {
  const add = useAddKnowledgeSource();
  const [kind, setKind] = useState<KnowledgeSource["kind"]>("markdown");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [content, setContent] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("internal");

  const ready = title.trim() !== "" && (kind === "url" ? url.trim() !== "" : content.trim() !== "");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready || add.isPending) return;
    const common = { title: title.trim(), visibility };
    add.mutate(
      kind === "url" ? { kind, url: url.trim(), ...common } : { kind, content, ...common },
      {
        onSuccess: onDone,
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Add a source</CardTitle>
        <CardDescription>
          A web page (one page, links aren't followed) or Markdown text. It's read in the
          background.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <fieldset className="flex gap-2">
            <legend className="sr-only">Kind</legend>
            {(["markdown", "url"] as const).map((k) => (
              <Button
                key={k}
                type="button"
                size="sm"
                variant={kind === k ? "primary" : "outline"}
                aria-pressed={kind === k}
                onClick={() => {
                  add.reset();
                  setKind(k);
                }}
              >
                {k === "url" ? "Web page" : "Markdown"}
              </Button>
            ))}
          </fieldset>
          <Input
            label="Title"
            maxLength={300}
            value={title}
            onChange={afterReset(add.reset, setTitle)}
            required
            disabled={add.isPending}
          />
          {kind === "url" ? (
            <Input
              label="URL"
              maxLength={2000}
              type="url"
              placeholder="https://…"
              value={url}
              onChange={afterReset(add.reset, setUrl)}
              required
              disabled={add.isPending}
            />
          ) : (
            <Textarea
              label="Content"
              maxLength={200_000}
              value={content}
              onChange={afterReset(add.reset, setContent)}
              rows={6}
              required
              disabled={add.isPending}
            />
          )}
          <Select
            label="Visibility"
            value={visibility}
            options={visibilityOptions}
            onChange={afterReset(add.reset, setVisibility)}
            disabled={add.isPending}
          />
          {add.isError ? (
            <Alert variant="destructive">
              <AlertIcon />
              <AlertContent>
                <AlertDescription>
                  {problem(
                    add.error,
                    "Couldn't add it.",
                    kind === "url"
                      ? "Enter the full address of a web page, starting with https://."
                      : "Check the title and content: one of them is too long.",
                  )}
                </AlertDescription>
              </AlertContent>
            </Alert>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onDone} disabled={add.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={add.isPending || !ready}>
              {add.isPending ? <Loader size={16} label="Adding" className="text-current" /> : null}
              Add source
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function webLink(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

const statusBadge = {
  pending: { status: "loading", label: "Reading" },
  ready: { status: "success", label: "Ready" },
  failed: { status: "danger", label: "Failed" },
} as const;

function SourceCard({ source, canWrite }: { source: KnowledgeSource; canWrite: boolean }) {
  const [mode, setMode] = useState<"view" | "edit" | "confirmDelete">("view");
  const reingest = useReingestKnowledgeSource();
  const remove = useDeleteKnowledgeSource();
  const inGit = source.managedBy === "git";
  const canChange = canWrite && !inGit;
  const badge = statusBadge[source.status];
  const busy = reingest.isPending || remove.isPending;
  const switchMode = (next: typeof mode) => {
    reingest.reset();
    remove.reset();
    setMode(next);
  };
  const resetReingest = reingest.reset;
  const resetRemove = remove.reset;
  // A source that moves to git can't be edited or deleted here, so its open form or confirm,
  // and any error from them, goes for good rather than coming back if it moves out again.
  useEffect(() => {
    if (!inGit) return;
    resetReingest();
    resetRemove();
    setMode("view");
  }, [inGit, resetReingest, resetRemove]);
  const link = source.url ? webLink(source.url) : null;

  return (
    <Card data-testid="knowledge-source">
      <CardHeader>
        <CardTitle as="h2">{source.title}</CardTitle>
        <CardDescription>
          {source.kind === "url" ? "Web page" : "Markdown"} ·{" "}
          {source.visibility === "public" ? "Public" : "Internal"} ·{" "}
          {source.chunkCount === 1 ? "1 passage" : `${source.chunkCount} passages`}
          {inGit ? ` · Managed in git${source.sourcePath ? ` (${source.sourcePath})` : ""}` : ""}
        </CardDescription>
        <CardAction>
          <AnimatedBadge status={badge.status} size="sm">
            {badge.label}
          </AnimatedBadge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 empty:hidden">
        {source.url ? (
          link ? (
            <a href={link} className="break-all text-sm underline" rel="noreferrer noopener">
              {source.url}
            </a>
          ) : (
            <span className="break-all text-sm">{source.url}</span>
          )
        ) : null}
        {source.error ? (
          <Alert variant={source.status === "failed" ? "destructive" : "default"}>
            <AlertIcon />
            <AlertContent>
              <AlertDescription>{knowledgeErrorMessage(source.error)}</AlertDescription>
            </AlertContent>
          </Alert>
        ) : null}
        {reingest.isError ? (
          <Alert variant="destructive">
            <AlertIcon />
            <AlertContent>
              <AlertDescription>
                {problem(reingest.error, "Couldn't read it again.")}
              </AlertDescription>
            </AlertContent>
          </Alert>
        ) : null}
        {remove.isError ? (
          <Alert variant="destructive">
            <AlertIcon />
            <AlertContent>
              <AlertDescription>{problem(remove.error, "Couldn't delete it.")}</AlertDescription>
            </AlertContent>
          </Alert>
        ) : null}
        {canChange && mode === "edit" ? (
          <EditSource source={source} onDone={() => switchMode("view")} />
        ) : null}
      </CardContent>
      {canChange && mode === "confirmDelete" ? (
        <CardFooter className="flex-wrap justify-end gap-2">
          <p className="mr-auto text-sm">Delete it? Drafts stop using it.</p>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => switchMode("view")}>
            Keep
          </Button>
          <Button
            variant="primary"
            size="sm"
            className="bg-destructive text-white hover:bg-destructive/90"
            disabled={busy}
            onClick={() => remove.mutate(source.id)}
          >
            {remove.isPending ? (
              <Loader size={16} label="Deleting" className="text-current" />
            ) : null}
            Delete
          </Button>
        </CardFooter>
      ) : null}
      {canWrite && inGit ? (
        <CardFooter>
          <p className="text-muted-foreground text-sm">
            To change it, edit its file in the workspace's git repo.
          </p>
        </CardFooter>
      ) : null}
      {canChange && mode === "view" ? (
        <CardFooter className="justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => switchMode("edit")}>
            Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || source.status === "pending"}
            onClick={() => {
              remove.reset();
              reingest.mutate(source.id);
            }}
          >
            Read again
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => switchMode("confirmDelete")}
          >
            Delete
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}

function EditSource({ source, onDone }: { source: KnowledgeSource; onDone: () => void }) {
  const edit = useEditKnowledgeSource();
  const [opened] = useState(source);
  // `undefined` until this person changes the field. Only fields they changed are sent, and
  // against the source as it is now, so someone else's change to another field survives.
  const [newTitle, setTitle] = useState<string>();
  const [newVisibility, setVisibility] = useState<Visibility>();
  const [content, setContent] = useState("");
  const title = newTitle ?? source.title;
  const visibility = newVisibility ?? source.visibility;

  const body = {
    ...(newTitle !== undefined && newTitle.trim() !== source.title.trim()
      ? { title: newTitle.trim() }
      : {}),
    ...(newVisibility !== undefined && newVisibility !== source.visibility
      ? { visibility: newVisibility }
      : {}),
    ...(source.kind === "markdown" && content.trim() !== "" ? { content } : {}),
  };
  const changed = Object.keys(body).length > 0;
  const onlySpaces = content !== "" && content.trim() === "";
  // Not after this person's own save, which changes it too before the form closes.
  const changedMeanwhile = (edit.isIdle || edit.isError) && source.updatedAt !== opened.updatedAt;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (changed && !onlySpaces && !edit.isPending)
      edit.mutate({ id: source.id, body }, { onSuccess: onDone });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {changedMeanwhile ? (
        <Alert variant="info">
          <AlertIcon />
          <AlertContent>
            <AlertDescription>
              This source was updated while you were editing. Saving changes only the fields you
              edit.
            </AlertDescription>
          </AlertContent>
        </Alert>
      ) : null}
      <Input
        label="Title"
        maxLength={300}
        value={title}
        onChange={afterReset(edit.reset, setTitle)}
        required
        disabled={edit.isPending}
      />
      <Select
        label="Visibility"
        value={visibility}
        options={visibilityOptions}
        onChange={afterReset(edit.reset, setVisibility)}
        disabled={edit.isPending}
      />
      {source.kind === "markdown" ? (
        <Textarea
          label="Replace content"
          maxLength={200_000}
          placeholder="Leave empty to keep the current text"
          value={content}
          onChange={afterReset(edit.reset, setContent)}
          rows={6}
          error={
            onlySpaces
              ? "That's only spaces. Add some text, or leave it empty to keep the current text."
              : undefined
          }
          disabled={edit.isPending}
        />
      ) : null}
      {edit.isError ? (
        <Alert variant="destructive">
          <AlertIcon />
          <AlertContent>
            <AlertDescription>
              {problem(
                edit.error,
                "Couldn't save. Nothing changed.",
                source.kind === "url"
                  ? "Use a title of at most 300 characters."
                  : "Check the title and content: one of them is too long.",
              )}
            </AlertDescription>
          </AlertContent>
        </Alert>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone} disabled={edit.isPending}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={edit.isPending || title.trim() === "" || !changed || onlySpaces}
        >
          Save
        </Button>
      </div>
    </form>
  );
}
