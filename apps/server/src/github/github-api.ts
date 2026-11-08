import { Octokit } from "@octokit/core";

/**
 * The GitHub calls the helpdesk makes, and nothing more: read a repo (to check a token when it
 * is connected) and open an issue. Opening an issue sends only a title and a body. There is no
 * way to pass labels, assignees or milestones through here, so neither the AI nor a caller can
 * add them (ADR 0004).
 */
export interface GithubApi {
  checkRepo(repo: RepoName): Promise<GithubResult<{ private: boolean }>>;
  createIssue(
    repo: RepoName,
    issue: { title: string; body: string },
  ): Promise<GithubResult<{ number: number; url: string }>>;
}

export type RepoName = { owner: string; name: string };

/**
 * Why GitHub said no, in words the API can pass on. Never GitHub's own message: that can echo
 * request details, and the token must never end up in a response or a log.
 */
export type GithubFailure = "token_rejected" | "repo_not_found" | "github_unavailable";
export type GithubResult<T> = { ok: true; value: T } | { ok: false; reason: GithubFailure };

/** Builds the API for one token. Tests pass a fake `fetch`, so no test ever calls GitHub. */
export type GithubApiFactory = (token: string) => GithubApi;

export interface OctokitOptions {
  /** HELPOS_GITHUB_API_URL: api.github.com, or a GitHub Enterprise server's API. */
  baseUrl: string;
  /** For tests: stands in for the network. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const userAgent = "helpdesk-github-integration";

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
          return { ok: true, value: { private: res.data.private } };
        } catch (error) {
          return { ok: false, reason: githubFailure(error) };
        }
      },
      async createIssue(repo, issue) {
        try {
          const res = await octokit.request("POST /repos/{owner}/{repo}/issues", {
            owner: repo.owner,
            repo: repo.name,
            title: issue.title,
            body: issue.body,
            request: { signal: signal() },
          });
          return { ok: true, value: { number: res.data.number, url: res.data.html_url } };
        } catch (error) {
          return { ok: false, reason: githubFailure(error) };
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
