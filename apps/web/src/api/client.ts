import createClient from "openapi-fetch";
import type { components, paths } from "./schema.gen.ts";

/**
 * The dashboard's only way to the server: a client generated from the public OpenAPI document,
 * so the dashboard can do nothing an agent with a token can't. Same origin, so the session
 * cookie goes along and no CORS is needed.
 */
export const api = createClient<paths>({ baseUrl: window.location.origin });

export type Conversation = components["schemas"]["Conversation"];
export type ConversationDetail = components["schemas"]["ConversationDetail"];
export type Message = components["schemas"]["Message"];
export type Draft = components["schemas"]["Draft"];
export type Me = components["schemas"]["Me"];
export type GithubIntegration = components["schemas"]["GithubIntegration"];
export type GithubConnected = components["schemas"]["GithubConnected"];
export type GithubIssueDraft = components["schemas"]["GithubIssueDraft"];
export type KnowledgeSource = components["schemas"]["KnowledgeSource"];
export type KnowledgeSourceUpdate = components["schemas"]["KnowledgeSourceUpdate"];
export type NewKnowledgeSource =
  paths["/v1/knowledge/sources"]["post"]["requestBody"]["content"]["application/json"];
export type ErrorCode = components["schemas"]["Error"]["error"];

/** A failed API call: the HTTP status and the API's error code, e.g. `not_pending`. */
export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`API error ${status}: ${code}`);
  }
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "error" in error) {
    return typeof error.error === "string" ? error.error : "unknown";
  }
  return "unknown";
}

/** The response body, or an ApiError. Never a silent `undefined`. */
export async function unwrap<T>(
  request: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await request;
  if (!response.ok) throw new ApiError(response.status, errorCode(error));
  return data as T;
}
