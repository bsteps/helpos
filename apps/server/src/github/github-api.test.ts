import { describe, expect, it } from "vitest";
import { githubFailure, parseRepo } from "./github-api.ts";

const answer = (status: number, headers: Record<string, string> = {}) => ({
  status,
  response: { headers },
});

describe("githubFailure", () => {
  it("tells a bad token from a missing repo", () => {
    expect(githubFailure(answer(401))).toBe("token_rejected");
    expect(githubFailure(answer(403))).toBe("token_rejected");
    expect(githubFailure(answer(404))).toBe("repo_not_found");
  });

  it("treats a rate limit as 'try later', even when GitHub sends it as 403", () => {
    expect(githubFailure(answer(403, { "x-ratelimit-remaining": "0" }))).toBe("github_unavailable");
    expect(githubFailure(answer(403, { "retry-after": "60" }))).toBe("github_unavailable");
    expect(githubFailure(answer(429))).toBe("github_unavailable");
  });

  it("treats anything else, a timeout included, as unavailable", () => {
    expect(githubFailure(answer(502))).toBe("github_unavailable");
    expect(githubFailure(new DOMException("timed out", "TimeoutError"))).toBe("github_unavailable");
    expect(githubFailure(null)).toBe("github_unavailable");
  });
});

describe("parseRepo", () => {
  it("lowercases owner/name and refuses anything else", () => {
    expect(parseRepo(" Acme/App.js ")).toEqual({ owner: "acme", name: "app.js" });
    for (const bad of ["acme", "acme/app/x", "../etc", "acme/..", "-acme/app", "acme/a b"]) {
      expect(parseRepo(bad), bad).toBeNull();
    }
  });
});
