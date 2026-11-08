/**
 * How many unverified webhook deliveries may be checked against the database at once, and how
 * many may wait their turn. Waiting, not refusing: a burst of forged requests slows real
 * deliveries by a few milliseconds each instead of turning them away (GitHub doesn't retry a
 * failed delivery by itself). One workspace's requests can hold only a share of the line, so a
 * flood aimed at one workspace's URL can't crowd out another's. A sustained flood beyond this
 * is for a rate limit at the proxy in front.
 */
export interface GateLimits {
  /** Checked at once, each holding a pooled connection for a moment. */
  concurrent: number;
  /** In line behind them, over all workspaces. */
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

/** Resolves to a release function once it's this request's turn, or null when turned away. */
export type Gate = (workspace: string) => Promise<(() => void) | null>;

export function createGate(limits: GateLimits = defaultGateLimits): Gate {
  let active = 0;
  const line: { workspace: string; start: () => void }[] = [];
  const perWorkspace = new Map<string, number>();

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
      line.shift()?.start();
    };
  };

  return async (workspace) => {
    if ((perWorkspace.get(workspace) ?? 0) >= limits.perWorkspace) return null;
    if (active < limits.concurrent) {
      active++;
      perWorkspace.set(workspace, (perWorkspace.get(workspace) ?? 0) + 1);
      return releaseFor(workspace);
    }
    if (line.length >= limits.waiting) return null;
    perWorkspace.set(workspace, (perWorkspace.get(workspace) ?? 0) + 1);
    return new Promise((resolve) => {
      const entry = {
        workspace,
        start: () => {
          clearTimeout(timer);
          active++;
          resolve(releaseFor(workspace));
        },
      };
      const timer = setTimeout(() => {
        const at = line.indexOf(entry);
        if (at >= 0) line.splice(at, 1);
        leave(workspace);
        resolve(null);
      }, limits.waitMs);
      line.push(entry);
    });
  };
}
