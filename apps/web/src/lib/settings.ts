import { ApiError } from "../api/client.ts";

export function shadowModeProblem(error: unknown): string {
  if (error instanceof ApiError && error.code === "shadow_mode_locked") {
    return "This server doesn't allow turning shadow mode off, so replies keep going to the shadow recipient. Whoever runs the server can allow it with HELPOS_ALLOW_SHADOW_MODE_OFF.";
  }
  if (error instanceof ApiError && error.status === 400) return "Enter a valid email address.";
  return "That didn't work. Nothing changed; try again.";
}

export function connectProblem(error: unknown): string {
  if (!(error instanceof ApiError)) return "That didn't work. Try again.";
  switch (error.code) {
    case "token_rejected":
      return "GitHub didn't accept this token. Check it hasn't expired and has Issues read and write access to the repo.";
    case "repo_not_found":
      return "GitHub says this repo doesn't exist, or the token can't see it.";
    case "github_unavailable":
      return "Couldn't reach GitHub. Try again.";
    case "encryption_not_configured":
      return "This server can't store tokens yet: whoever runs it needs to set HELPOS_ENCRYPTION_KEY.";
    default:
      return error.status === 400
        ? "Enter the repo as owner/name, e.g. acme/app."
        : "That didn't work. Try again.";
  }
}
