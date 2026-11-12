import { ApiError, type KnowledgeSource, type KnowledgeSourceUpdate } from "../api/client.ts";

import { errorMessage } from "../api/error-messages.ts";

export function knowledgeProblem(error: unknown, failed: string, invalid = `${failed} Try again.`): string {
  if (!(error instanceof ApiError)) {
    return `${failed} Something went wrong. Check your connection, then try again or reload the page.`;
  }
  const specific = errorMessage(
    error.code,
    {
      url_taken: `${failed} There's already a source for this URL.`,
      slug_taken: `${failed} There's already a source with this title.`,
      managed_in_git: `${failed} It's managed in the workspace's git repo now.`,
    },
    "",
  );
  if (specific) return specific;
  if (error.status === 404) return `${failed} It's no longer in this workspace.`;
  if (error.status === 401) return `${failed} You've been signed out. Sign in again, then retry.`;
  const forbidden = errorMessage(
    error.code,
    { forbidden: `${failed} Your account can't change knowledge sources.` },
    "",
  );
  if (forbidden) return forbidden;
  if (error.status === 403) return `${failed} Reload the page, then try again.`;
  if (error.status === 400) return invalid;
  return `${failed} Try again.`;
}

/** A form's error is about what was sent, so it goes once any field changes. */
export const blankTitle = (title: string) =>
  title !== "" && title.trim() === "" ? "Add a title." : false;

type EditableSource = Pick<KnowledgeSource, "title" | "visibility" | "kind">;

export function knowledgeEditBody({
  source,
  newTitle,
  newVisibility,
  content,
}: {
  source: EditableSource;
  newTitle: string | undefined;
  newVisibility: KnowledgeSource["visibility"] | undefined;
  content: string;
}): KnowledgeSourceUpdate {
  return {
    ...(newTitle !== undefined && newTitle.trim() !== source.title.trim()
      ? { title: newTitle.trim() }
      : {}),
    ...(newVisibility !== undefined && newVisibility !== source.visibility
      ? { visibility: newVisibility }
      : {}),
    ...(source.kind === "markdown" && content.trim() !== "" ? { content } : {}),
  };
}

type SourceRevision = Pick<KnowledgeSource, "title" | "visibility" | "state" | "updatedAt">;

export function knowledgeChangedMeanwhile({
  source,
  opened,
  mutationStatus,
}: {
  source: SourceRevision;
  opened: SourceRevision;
  mutationStatus: "idle" | "error" | "pending" | "success";
}): boolean {
  return (
    (mutationStatus === "idle" || mutationStatus === "error") &&
    (source.title !== opened.title ||
      source.visibility !== opened.visibility ||
      ((source.state.status === "pending" || source.state.status === "waiting") &&
        source.updatedAt !== opened.updatedAt))
  );
}
