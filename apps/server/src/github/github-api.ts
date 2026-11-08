import { brand } from "@helpos/brand";
import { Octokit } from "@octokit/core";

/**
 * The GitHub calls the helpdesk makes, and nothing more:
 * - read the repo and the token's own account, to check a token when it is connected;
 * - open an issue, sending only a title and a body;
 * - list the repo's newest issues, to find one it opened when GitHub's answer was lost, and
 *   read which account the token belongs to, so it only ever recognises its own issues.
 * All of them fit the token's "Issues: read and write" permission (`GET /user` needs none). There is no way to pass
 * labels, assignees or milestones through here, so neither the AI nor a caller can add them:
 * what the customer wrote is data, never instructions.
 */
export interface GithubApi {
  checkRepo(repo: RepoName): Promise<GithubResult<{ private: boolean }>>;
  /**
   * `marker` goes at the end of the body as an HTML comment, which GitHub doesn't show. It is
   * the claim's ID, so findIssue() can later recognise exactly this issue and no other.
   */
  createIssue(
    repo: RepoName,
    issue: { title: string; body: string; marker: string },
  ): Promise<GithubResult<CreatedIssue>>;
  /**
   * The issue carrying `marker`, opened since `since`, if there is one. Opening an issue can't
   * be made idempotent on GitHub, so when the answer to a create is lost (a timeout, a dropped
   * connection, a 5xx), this finds the issue GitHub may have opened anyway.
   */
  findIssue(
    repo: RepoName,
    lookup: { marker: string; since: Date },
  ): Promise<GithubResult<CreatedIssue | null>>;
  /**
   * The issue's state now. An issue can be closed before its link is written (a fast
   * maintainer, or an issue found again minutes later), and the webhook for that close has
   * nothing to match yet: the caller checks this once the link exists.
   */
  issueState(repo: RepoName, number: number): Promise<GithubResult<IssueState>>;
}

export type IssueState = {
  state: "open" | "closed";
  stateReason: string | null;
  /** GitHub's `updated_at`: orders this reading against webhook deliveries. */
  updatedAt: Date | null;
};

/**
 * The hidden line that ties an issue to the claim that opened it. A fixed string on purpose,
 * not the brand: it is stored in issues on GitHub, and a renamed product must still recognise
 * the issues it opened before.
 */
export function markerComment(marker: string): string {
  return `<!-- helpdesk-claim:${marker} -->`;
}

export type CreatedIssue = { number: number; url: string };

export type RepoName = { owner: string; name: string };

/**
 * Why GitHub said no, in words the API can pass on. Never GitHub's own message: that can echo
 * request details, and the token must never end up in a response or a log.
 */
export type GithubFailure = "token_rejected" | "repo_not_found" | "github_unavailable";
/**
 * `uncertain`: GitHub never gave an answer (a timeout, a dropped connection) or failed on its
 * side (5xx), so a write may have happened. A clear refusal (4xx) is never uncertain.
 */
export type GithubResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: GithubFailure; uncertain: boolean };

/** Builds the API for one token. Tests pass a fake `fetch`, so no test ever calls GitHub. */
export type GithubApiFactory = (token: string) => GithubApi;

export interface OctokitOptions {
  /** HELPOS_GITHUB_API_URL: api.github.com, or a GitHub Enterprise server's API. */
  baseUrl: string;
  /** For tests: stands in for the network. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const userAgent = `${brand.slug}-github-integration`;

/** What GitHub's answer says. Only the status and rate-limit headers: never its message. */
export function githubFailure(error: unknown): GithubFailure {
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null;
  const status = isObject(error) ? error.status : undefined;
  const headers =
    isObject(error) && isObject(error.response) && isObject(error.response.headers)
      ? error.response.headers
      : {};
  // GitHub answers a rate limit with 403 too: that's "try later", not a bad token.
  const rateLimited =
    status === 429 || headers["x-ratelimit-remaining"] === "0" || "retry-after" in headers;
  if (rateLimited) return "github_unavailable";
  // 401: bad or expired token. 403: the token lacks Issues permission on this repo.
  if (status === 401 || status === 403) return "token_rejected";
  // GitHub answers 404 for a private repo the token can't see, so this also means "no access".
  if (status === 404 || status === 410) return "repo_not_found";
  return "github_unavailable";
}

/**
 * Octokit reports a timeout, an abort or a network failure as status 500, like GitHub's own
 * 5xx: then the request may have reached GitHub. An error with no status never got that far
 * (a bug before sending), so it is a plain failure.
 */
function failed(error: unknown): { ok: false; reason: GithubFailure; uncertain: boolean } {
  const status =
    typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
  const uncertain = typeof status === "number" && status >= 500;
  return { ok: false, reason: githubFailure(error), uncertain };
}

/**
 * Pages of the newest issues to look through before giving up. The search normally ends on the
 * first page, at the first issue older than the window; this only bounds a pathological repo.
 * Running out of pages is "don't know", never "not there": that could open a duplicate.
 */
const lookupPages = 20;
/** And at most this long in all: an issue search must end well before a claim goes stale. */
const lookupBudgetMs = 60_000;

export function octokitGithub(options: OctokitOptions): GithubApiFactory {
  const timeoutMs = options.timeoutMs ?? 10_000;
  return (token) => {
    const octokit = new Octokit({
      auth: token,
      baseUrl: options.baseUrl,
      userAgent,
      // No logging from Octokit itself: its messages are not ours to vet.
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      ...(options.fetch ? { request: { fetch: options.fetch } } : {}),
    });
    const signal = () => AbortSignal.timeout(timeoutMs);
    return {
      async checkRepo(repo) {
        try {
          const res = await octokit.request("GET /repos/{owner}/{repo}", {
            owner: repo.owner,
            repo: repo.name,
            request: { signal: signal() },
          });
          // Finding an issue whose answer was lost needs the token's own account. A token that
          // can't tell it (some app tokens) is refused now, not at the worst moment later.
          await octokit.request("GET /user", { request: { signal: signal() } });
          return { ok: true, value: { private: res.data.private } };
        } catch (error) {
          return failed(error);
        }
      },
      async createIssue(repo, issue) {
        try {
          const res = await octokit.request("POST /repos/{owner}/{repo}/issues", {
            owner: repo.owner,
            repo: repo.name,
            title: issue.title,
            body: `${issue.body}\n\n${markerComment(issue.marker)}`,
            request: { signal: signal() },
          });
          return { ok: true, value: { number: res.data.number, url: res.data.html_url } };
        } catch (error) {
          return failed(error);
        }
      },
      async findIssue(repo, lookup) {
        const comment = markerComment(lookup.marker);
        try {
          // Anyone who can read the repo can see a marker and copy it into an issue of their
          // own. So only an issue opened by this token's own account counts, with the marker
          // as its very last line, and of several, the oldest: the one we opened came first.
          const me = await octokit.request("GET /user", { request: { signal: signal() } });
          let match: CreatedIssue | undefined;
          let searchedAll = false;
          const deadline = Date.now() + lookupBudgetMs;
          for (let page = 1; page <= lookupPages && Date.now() < deadline; page++) {
            // Newest first, so the search can stop at the first issue older than `since`.
            const res = await octokit.request("GET /repos/{owner}/{repo}/issues", {
              owner: repo.owner,
              repo: repo.name,
              state: "all",
              sort: "created",
              direction: "desc",
              since: lookup.since.toISOString(),
              per_page: 50,
              page,
              request: { signal: signal() },
            });
            // Newest first, so a later match on a later page is older: keep the last one seen.
            for (const i of res.data) {
              const ours =
                !i.pull_request &&
                i.user?.login === me.data.login &&
                (i.body ?? "").trimEnd().endsWith(comment);
              if (ours) match = { number: i.number, url: i.html_url };
            }
            const last = res.data.at(-1);
            if (res.data.length < 50 || !last || new Date(last.created_at) < lookup.since) {
              searchedAll = true;
              break;
            }
          }
          if (!match && !searchedAll) {
            return { ok: false, reason: "github_unavailable", uncertain: true };
          }
          return { ok: true, value: match ?? null };
        } catch (error) {
          return failed(error);
        }
      },
      async issueState(repo, number) {
        try {
          const res = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
            owner: repo.owner,
            repo: repo.name,
            issue_number: number,
            request: { signal: signal() },
          });
          return {
            ok: true,
            value: {
              state: res.data.state === "closed" ? "closed" : "open",
              stateReason: res.data.state_reason ?? null,
              updatedAt: res.data.updated_at ? new Date(res.data.updated_at) : null,
            },
          };
        } catch (error) {
          return failed(error);
        }
      },
    };
  };
}

/** `owner/name` → its parts, lowercase. GitHub's own rules for both names. */
export function parseRepo(full: string): RepoName | null {
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(full.trim());
  if (!match?.[1] || !match[2] || match[2] === "." || match[2] === "..") return null;
  return { owner: match[1].toLowerCase(), name: match[2].toLowerCase() };
}

export const repoString = (repo: RepoName) => `${repo.owner}/${repo.name}`;
