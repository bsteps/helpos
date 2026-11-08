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
 * Connecting, rotating and disconnecting forget the workspace's entry at once, and a lookup
 * that was already reading the old secret then can't put it back: each forget starts a new
 * generation, and only a lookup begun in the current one may store its answer. Another server
 * process sees such a change within `maxAgeMs`.
 */
export interface WebhookSecrets {
  /** The secret read for this workspace (null: none), and how long ago, if still fresh. */
  get(tenantId: string): { secret: string | null; ageMs: number } | undefined;
  /** Call before reading the database; pass the answer to set(). */
  generation(tenantId: string): number;
  /** Stores what a lookup read, unless the entry was forgotten since it began. */
  set(tenantId: string, secret: string | null, generation: number): void;
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
  // Short, as it bounds how long another process accepts a rotated or removed secret; a
  // lookup every 15 seconds per workspace, even under a flood, is nothing.
  maxAgeMs: 15_000,
  max: 10_000,
};

export function createWebhookSecrets(
  options: WebhookSecretsOptions = defaultWebhookSecretsOptions,
): WebhookSecrets {
  const now = options.now ?? Date.now;
  const entries = new Map<string, { secret: string | null; at: number }>();
  // Only workspaces forgotten at least once, so a flood of made-up ones can't grow it: a
  // workspace is forgotten only by an admin action. Kept to the same size, oldest out first.
  const generations = new Map<string, number>();
  return {
    generation: (tenantId) => generations.get(tenantId) ?? 0,
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
    set(tenantId, secret, generation) {
      if ((generations.get(tenantId) ?? 0) !== generation) return;
      entries.delete(tenantId);
      entries.set(tenantId, { secret, at: now() });
      if (entries.size > options.max) {
        const oldest = entries.keys().next();
        if (!oldest.done) entries.delete(oldest.value);
      }
    },
    forget(tenantId) {
      entries.delete(tenantId);
      const next = (generations.get(tenantId) ?? 0) + 1;
      generations.delete(tenantId);
      generations.set(tenantId, next);
      if (generations.size > options.max) {
        const oldest = generations.keys().next();
        if (!oldest.done) generations.delete(oldest.value);
      }
    },
  };
}
