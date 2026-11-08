/**
 * Workspaces' webhook secrets, as last read from the database, kept for a short while.
 *
 * A forged request names a real workspace as easily as a made-up one. Without this, each one
 * would cost a database lookup, and a flood naming one workspace could hold the verification
 * line so its real deliveries are turned away (GitHub doesn't retry them). With it, a request
 * for a workspace looked up moments ago is checked in memory: a forged one is refused with no
 * database work at all. "No secret" (no repo connected, or unreadable) is kept too, so made-up
 * workspaces repeated cost nothing either.
 *
 * Connecting, rotating and disconnecting forget the workspace's entry at once. Another server
 * process sees such a change within `maxAgeMs`.
 */
export interface WebhookSecrets {
  /** The secret read for this workspace (null: none), and how long ago, if still fresh. */
  get(tenantId: string): { secret: string | null; ageMs: number } | undefined;
  set(tenantId: string, secret: string | null): void;
  forget(tenantId: string): void;
}

export interface WebhookSecretsOptions {
  /** How long an entry is trusted. */
  maxAgeMs: number;
  /** How many workspaces are kept; the oldest goes first, so a flood can't grow it. */
  max: number;
  now?: () => number;
}

export const defaultWebhookSecretsOptions: WebhookSecretsOptions = {
  maxAgeMs: 60_000,
  max: 10_000,
};

export function createWebhookSecrets(
  options: WebhookSecretsOptions = defaultWebhookSecretsOptions,
): WebhookSecrets {
  const now = options.now ?? Date.now;
  const entries = new Map<string, { secret: string | null; at: number }>();
  return {
    get(tenantId) {
      const entry = entries.get(tenantId);
      if (!entry) return undefined;
      const ageMs = now() - entry.at;
      if (ageMs >= options.maxAgeMs) {
        entries.delete(tenantId);
        return undefined;
      }
      return { secret: entry.secret, ageMs };
    },
    set(tenantId, secret) {
      entries.delete(tenantId);
      entries.set(tenantId, { secret, at: now() });
      if (entries.size > options.max) {
        const oldest = entries.keys().next();
        if (!oldest.done) entries.delete(oldest.value);
      }
    },
    forget(tenantId) {
      entries.delete(tenantId);
    },
  };
}
