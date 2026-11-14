import type { ErrorCode } from "./client.ts";

const generic = "That didn't work. Try again.";

const errorMessages = {
  already_answered: generic,
  bad_request: generic,
  busy: generic,
  content_not_editable: generic,
  conversation_closed: generic,
  daily_budget_reached: generic,
  forbidden: generic,
  forbidden_origin: generic,
  idempotency_conflict: generic,
  idempotency_expired: generic,
  idempotency_not_supported: generic,
  idempotency_pending: generic,
  idempotency_unavailable: generic,
  internal_error: generic,
  invalid_credentials: generic,
  invalid_idempotency_key: generic,
  invalid_token: generic,
  managed_in_git: generic,
  missing_from: generic,
  not_current_uncertain_send: generic,
  not_found: generic,
  not_pending: generic,
  not_ready: generic,
  not_send_failed: generic,
  nothing_to_answer: generic,
  scope_not_held: generic,
  session_required: generic,
  sessions_disabled: generic,
  shadow_mode_locked: generic,
  slug_taken: generic,
  too_large: generic,
  unauthorized: generic,
  unknown_mailbox: generic,
  unsupported_media_type: generic,
  url_taken: generic,
} satisfies Record<ErrorCode, string>;

export type ErrorMessages = Partial<Record<ErrorCode, string>>;

function isErrorCode(code: string | undefined): code is ErrorCode {
  return code !== undefined && Object.hasOwn(errorMessages, code);
}

export function errorMessage(
  code: string | undefined,
  overrides: ErrorMessages,
  fallback?: string,
): string {
  return isErrorCode(code)
    ? (overrides[code] ?? fallback ?? errorMessages[code])
    : (fallback ?? generic);
}
