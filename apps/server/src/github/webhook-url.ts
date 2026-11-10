/** Where GitHub sends a workspace's issue events. */
export const webhookPath = "/v1/integrations/github/webhook";

/** The address an admin pastes into GitHub: the public URL, the webhook path, the workspace. */
export function webhookUrl(publicUrl: string, tenantId: string): string {
  // Keeps any path in the public URL (e.g. `https://acme.test/helpdesk`).
  const base = publicUrl.endsWith("/") ? publicUrl : `${publicUrl}/`;
  const url = new URL(webhookPath.slice(1), base);
  url.searchParams.set("workspace", tenantId);
  return url.toString();
}
