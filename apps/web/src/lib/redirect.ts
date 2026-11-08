/**
 * Where to go after signing in. Only a path on this site: a full URL here would let a link to
 * the login page send someone elsewhere afterwards (an open redirect).
 */
export function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // Browsers drop tabs and newlines from URLs, so "/\t/evil.test" would become //evil.test.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
  const hasControl = /[\u0000-\u001f\u007f]/.test(value);
  return value.startsWith("/") && !value.startsWith("//") && !value.includes("\\") && !hasControl
    ? value
    : undefined;
}
