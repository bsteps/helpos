/**
 * Where to go after signing in. Only a path on this site: a full URL here would let a link to
 * the login page send someone elsewhere afterwards (an open redirect).
 */
export function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")
    ? value
    : undefined;
}
