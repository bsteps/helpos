/**
 * How many unverified webhook deliveries may be checked against the database at once, and how
 * many may wait their turn. Waiting, not refusing: a burst of forged requests slows real
 * deliveries by a few milliseconds each instead of turning them away (GitHub doesn't retry a
 * failed delivery by itself).
 *
 * The workspace in the URL is chosen by the caller, so it can't be trusted for fairness on its
 * own: a flood can name a fresh random workspace on every request. Workspaces that have had a
 * delivery verified (GitHub pings a webhook as soon as it is set up) wait in their own line,
 * which goes first: a forged request never verifies, so it never gets into that line. Each
 * workspace can hold only a share of either line, so a flood aimed at one workspace's URL
 * can't crowd out another's. A sustained flood beyond this is for a rate limit at the proxy.
 */
export interface GateLimits {
  /** Checked at once, each holding a pooled connection for a moment. */
  concurrent: number;
  /** In each line behind them, over all workspaces. */
  waiting: number;
  /** Checked or in line for one workspace. */
  perWorkspace: number;
  /** How long one may wait before it is turned away. */
  waitMs: number;
}

export const defaultGateLimits: GateLimits = {
  concurrent: 4,
  waiting: 256,
  perWorkspace: 16,
  waitMs: 5_000,
};

/**
 * Resolves to a release function once it's this request's turn, or null when turned away.
 * `known`: the workspace has had a delivery verified, so it waits in the line that goes first.
 */
export type Gate = (workspace: string, known: boolean) => Promise<(() => void) | null>;

type Waiter = { start: () => void };

export function createGate(limits: GateLimits = defaultGateLimits): Gate {
  let active = 0;
  const knownLine: Waiter[] = [];
  const otherLine: Waiter[] = [];
  const perWorkspace = new Map<string, number>();

  const join = (workspace: string) =>
    perWorkspace.set(workspace, (perWorkspace.get(workspace) ?? 0) + 1);
  const leave = (workspace: string) => {
    const left = (perWorkspace.get(workspace) ?? 1) - 1;
    if (left > 0) perWorkspace.set(workspace, left);
    else perWorkspace.delete(workspace);
  };
  const releaseFor = (workspace: string) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active--;
      leave(workspace);
      (knownLine.shift() ?? otherLine.shift())?.start();
    };
  };

  return async (workspace, known) => {
    if ((perWorkspace.get(workspace) ?? 0) >= limits.perWorkspace) return null;
    if (active < limits.concurrent) {
      active++;
      join(workspace);
      return releaseFor(workspace);
    }
    const line = known ? knownLine : otherLine;
    if (line.length >= limits.waiting) return null;
    join(workspace);
    return new Promise((resolve) => {
      const waiter: Waiter = {
        start: () => {
          clearTimeout(timer);
          active++;
          resolve(releaseFor(workspace));
        },
      };
      const timer = setTimeout(() => {
        const at = line.indexOf(waiter);
        if (at >= 0) line.splice(at, 1);
        leave(workspace);
        resolve(null);
      }, limits.waitMs);
      line.push(waiter);
    });
  };
}

/** A set of IDs that forgets its oldest past `max`, so a flood of new ones can't grow it. */
export function recentIds(max: number): {
  has(id: string): boolean;
  add(id: string): void;
  delete(id: string): void;
} {
  const ids = new Set<string>();
  return {
    has: (id) => ids.has(id),
    delete: (id) => {
      ids.delete(id);
    },
    add: (id) => {
      // Re-added, it counts as new again.
      ids.delete(id);
      ids.add(id);
      if (ids.size > max) {
        const oldest = ids.values().next();
        if (!oldest.done) ids.delete(oldest.value);
      }
    },
  };
}
