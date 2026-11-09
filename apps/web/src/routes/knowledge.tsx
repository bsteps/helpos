import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";
import { ApiError, type KnowledgeSource } from "@/api/client.ts";
import {
  knowledgeSourcesQuery,
  useAddKnowledgeSource,
  useDeleteKnowledgeSource,
  useEditKnowledgeSource,
  useReingestKnowledgeSource,
} from "@/api/queries.ts";
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
      {sources.isError && !sources.data ? (
        <Alert variant="destructive">
          <AlertIcon />
          <AlertContent>
            <AlertDescription>Couldn't load the knowledge sources.</AlertDescription>
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

function VisibilitySelect({
  value,
  onChange,
  disabled,
}: {
  value: Visibility;
  onChange: (value: Visibility) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="px-1 font-medium text-foreground text-sm">
        Visibility
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === "public" ? "public" : "internal")}
        className="h-10 rounded-full border border-border bg-card px-4 text-sm"
      >
        <option value="internal">Internal: for the AI only</option>
        <option value="public">Public: may be shown to customers</option>
      </select>
    </div>
  );
}

function addProblem(error: unknown, kind: KnowledgeSource["kind"]): string {
  if (error instanceof ApiError) {
    if (error.code === "url_taken") return "There's already a source for this URL.";
    if (error.code === "slug_taken") return "There's already a source with this title.";
    if (error.status === 400) {
      return kind === "url"
        ? "Enter the full address of a web page, starting with https://."
        : "Check the title and content: one of them is too long.";
    }
  }
  return "That didn't work. Try again.";
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
    if (!ready) return;
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
                onClick={() => setKind(k)}
              >
                {k === "url" ? "Web page" : "Markdown"}
              </Button>
            ))}
          </fieldset>
          <Input
            label="Title"
            value={title}
            onChange={setTitle}
            required
            disabled={add.isPending}
          />
          {kind === "url" ? (
            <Input
              label="URL"
              type="url"
              placeholder="https://…"
              value={url}
              onChange={setUrl}
              required
              disabled={add.isPending}
            />
          ) : (
            <Textarea
              label="Content"
              value={content}
              onChange={setContent}
              rows={6}
              required
              disabled={add.isPending}
            />
          )}
          <VisibilitySelect value={visibility} onChange={setVisibility} disabled={add.isPending} />
          {add.isError ? (
            <Alert variant="destructive">
              <AlertIcon />
              <AlertContent>
                <AlertDescription>{addProblem(add.error, kind)}</AlertDescription>
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
  const badge = statusBadge[source.status];
  const busy = reingest.isPending || remove.isPending;
  const switchMode = (next: typeof mode) => {
    reingest.reset();
    remove.reset();
    setMode(next);
  };
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
      {source.url || source.error || reingest.isError || remove.isError || mode === "edit" ? (
        <CardContent className="flex flex-col gap-3">
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
          {reingest.isError || remove.isError ? (
            <Alert variant="destructive">
              <AlertIcon />
              <AlertContent>
                <AlertDescription>
                  {reingest.isError ? "Couldn't read it again." : "Couldn't delete it."} Try again.
                </AlertDescription>
              </AlertContent>
            </Alert>
          ) : null}
          {mode === "edit" ? (
            <EditSource source={source} onDone={() => switchMode("view")} />
          ) : null}
        </CardContent>
      ) : null}
      {canWrite && !inGit && mode === "confirmDelete" ? (
        <CardFooter className="flex-wrap justify-end gap-2">
          <p className="mr-auto text-sm">Delete it? Drafts stop using it.</p>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => switchMode("view")}>
            Keep
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={busy}
            onClick={() => remove.mutate(source.id)}
          >
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
      {canWrite && !inGit && mode === "view" ? (
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
  const [title, setTitle] = useState(source.title);
  const [visibility, setVisibility] = useState<Visibility>(source.visibility);
  const [content, setContent] = useState("");

  const body = {
    ...(title.trim() !== source.title.trim() ? { title: title.trim() } : {}),
    ...(visibility !== source.visibility ? { visibility } : {}),
    ...(source.kind === "markdown" && content.trim() !== "" ? { content } : {}),
  };
  const changed = Object.keys(body).length > 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (changed) edit.mutate({ id: source.id, body }, { onSuccess: onDone });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Input label="Title" value={title} onChange={setTitle} required disabled={edit.isPending} />
      <VisibilitySelect value={visibility} onChange={setVisibility} disabled={edit.isPending} />
      {source.kind === "markdown" ? (
        <Textarea
          label="Replace content"
          placeholder="Leave empty to keep the current text"
          value={content}
          onChange={setContent}
          rows={6}
          disabled={edit.isPending}
        />
      ) : null}
      {edit.isError ? (
        <Alert variant="destructive">
          <AlertIcon />
          <AlertContent>
            <AlertDescription>Couldn't save. Nothing changed; try again.</AlertDescription>
          </AlertContent>
        </Alert>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone} disabled={edit.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={edit.isPending || title.trim() === "" || !changed}>
          Save
        </Button>
      </div>
    </form>
  );
}
