/**
 * Decides whether the seed may write to these databases. The seed's tokens are public (they are
 * in the repo), so seeding production would hand out working credentials. Pure, so it is tested
 * without a database.
 *
 * Refuses when NODE_ENV or HELPOS_ENV says production, or when a database isn't on this machine.
 * A dev database elsewhere (say a docker-compose service name) can be allowed by naming its host
 * in HELPOS_SEED_ALLOW_HOSTS, comma-separated: an explicit, per-host opt-in.
 */
export type SeedGuardResult = { ok: true } | { ok: false; reason: string };

const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function checkSeedTarget(
  env: Record<string, string | undefined>,
  databaseUrls: string[],
): SeedGuardResult {
  for (const name of ["NODE_ENV", "HELPOS_ENV"]) {
    if (env[name]?.trim().toLowerCase() === "production") {
      return { ok: false, reason: `${name} is "production"` };
    }
  }
  const allowed = new Set(
    (env.HELPOS_SEED_ALLOW_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const raw of databaseUrls) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, reason: "a database URL is not a valid URL" };
    }
    // Drivers let `?host=` override the host in the URL, which would slip past this check.
    if (url.searchParams.has("host") || url.searchParams.has("hostaddr")) {
      return { ok: false, reason: "a database URL sets its host in the query string" };
    }
    const host = url.hostname.toLowerCase();
    if (!localHosts.has(host) && !/^127(\.\d{1,3}){3}$/.test(host) && !allowed.has(host)) {
      return {
        ok: false,
        reason: `database host "${host}" is not local (allow a dev host with HELPOS_SEED_ALLOW_HOSTS)`,
      };
    }
  }
  return { ok: true };
}
