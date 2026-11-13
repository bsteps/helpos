import { ApiError } from "../api/client.ts";
import { errorMessage } from "../api/error-messages.ts";

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
