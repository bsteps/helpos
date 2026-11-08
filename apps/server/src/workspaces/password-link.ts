/**
 * The dashboard page that sets a password. The token is in the fragment (`#`), which browsers
 * never send to a server: it stays out of access logs, proxies and `Referer` headers.
 */
export function passwordSetupLink(publicUrl: string, token: string): string {
  const link = new URL("set-password", publicUrl.endsWith("/") ? publicUrl : `${publicUrl}/`);
  link.hash = new URLSearchParams({ token }).toString();
  return link.toString();
}
