import { afterAll, describe, expect, it, vi } from "vitest";

vi.stubGlobal("window", { location: { origin: "http://localhost" } });
const { ApiError } = await import("../api/client.ts");
const { signInProblem, setPasswordProblem } = await import("./auth.ts");
const { shadowModeProblem, connectProblem } = await import("./settings.ts");
afterAll(() => vi.unstubAllGlobals());

describe("settings errors", () => {
  it.each([
    [
      400,
      "shadow_mode_locked",
      "This server doesn't allow turning shadow mode off, so replies keep going to the shadow recipient. Whoever runs the server can allow it with HELPOS_ALLOW_SHADOW_MODE_OFF.",
    ],
    [400, "invalid", "Enter a valid email address."],
    [403, "unknown", "That didn't work. Nothing changed; try again."],
  ])("maps shadow mode %s / %s", (status, code, message) => {
    expect(shadowModeProblem(new ApiError(status, code))).toBe(message);
  });

  it.each([
    [
      400,
      "token_rejected",
      "GitHub didn't accept this token. Check it hasn't expired and has Issues read and write access to the repo.",
    ],
    [400, "repo_not_found", "GitHub says this repo doesn't exist, or the token can't see it."],
    [400, "github_unavailable", "Couldn't reach GitHub. Try again."],
    [
      400,
      "encryption_not_configured",
      "This server can't store tokens yet: whoever runs it needs to set HELPOS_ENCRYPTION_KEY.",
    ],
    [400, "unknown", "Enter the repo as owner/name, e.g. acme/app."],
    [500, "unknown", "That didn't work. Try again."],
  ])("maps GitHub %s / %s", (status, code, message) => {
    expect(connectProblem(new ApiError(status, code))).toBe(message);
  });

  it.each([null, undefined, new Error("network"), { status: 400, code: "shadow_mode_locked" }])(
    "uses fallbacks for non-API error %s",
    (error) => {
      expect(shadowModeProblem(error)).toBe("That didn't work. Nothing changed; try again.");
      expect(connectProblem(error)).toBe("That didn't work. Try again.");
    },
  );
});

describe("sign-in errors", () => {
  it.each([
    [401, "Wrong email or password."],
    [503, "Sign-in isn't set up on this server yet. Ask whoever runs it."],
    [400, "Couldn't sign in. Try again."],
    [500, "Couldn't sign in. Try again."],
  ])("maps status %s", (status, message) => {
    expect(signInProblem(new ApiError(status, "unknown"))).toBe(message);
  });

  it.each([
    [400, "This link has expired or was already used. Ask for a new one."],
    [401, "Couldn't set the password. Try again."],
    [500, "Couldn't set the password. Try again."],
  ])("maps set-password status %s", (status, message) => {
    expect(setPasswordProblem(new ApiError(status, "unknown"))).toBe(message);
  });

  it.each([null, undefined, new Error("network"), { status: 401 }, { status: 400 }])(
    "uses fallbacks for non-API error %s",
    (error) => {
      expect(signInProblem(error)).toBe("Couldn't sign in. Try again.");
      expect(setPasswordProblem(error)).toBe("Couldn't set the password. Try again.");
    },
  );
});
