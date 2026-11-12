import { ApiError } from "../api/client.ts";
import { type ErrorMessages, errorMessage } from "../api/error-messages.ts";

export function shadowModeProblem(error: unknown): string {
  return errorMessage(
    error instanceof ApiError ? error.code : undefined,
    {
      shadow_mode_locked:
        "This server doesn't allow turning shadow mode off, so replies keep going to the shadow recipient. Whoever runs the server can allow it with HELPOS_ALLOW_SHADOW_MODE_OFF.",
    },
    error instanceof ApiError && error.status === 400
      ? "Enter a valid email address."
      : "That didn't work. Nothing changed; try again.",
  );
}

const connectMessages = {
  token_rejected:
    "GitHub didn't accept this token. Check it hasn't expired and has Issues read and write access to the repo.",
  repo_not_found: "GitHub says this repo doesn't exist, or the token can't see it.",
  github_unavailable: "Couldn't reach GitHub. Try again.",
  encryption_not_configured:
    "This server can't store tokens yet: whoever runs it needs to set HELPOS_ENCRYPTION_KEY.",
} satisfies ErrorMessages;

export function connectProblem(error: unknown): string {
  return errorMessage(
    error instanceof ApiError ? error.code : undefined,
    connectMessages,
    error instanceof ApiError && error.status === 400
      ? "Enter the repo as owner/name, e.g. acme/app."
      : undefined,
  );
}

