import { afterAll, describe, expect, it, vi } from "vitest";

vi.stubGlobal("window", { location: { origin: "http://localhost" } });
const { ApiError } = await import("../api/client.ts");
const { signInProblem, setPasswordProblem } = await import("./auth.ts");
const { shadowModeProblem, connectProblem } = await import("./settings.ts");
const { knowledgeProblem, blankTitle, knowledgeEditBody, knowledgeChangedMeanwhile } = await import(
  "./knowledge-form.ts"
);
afterAll(() => vi.unstubAllGlobals());

describe("knowledgeProblem", () => {
  it.each([
    [400, "url_taken", "There's already a source for this URL."],
    [401, "slug_taken", "There's already a source with this title."],
    [404, "managed_in_git", "It's managed in the workspace's git repo now."],
    [404, "forbidden", "It's no longer in this workspace."],
    [401, "forbidden", "You've been signed out. Sign in again, then retry."],
    [400, "forbidden", "Your account can't change knowledge sources."],
    [403, "unknown", "Reload the page, then try again."],
    [400, "unknown", "Try again."],
    [500, "unknown", "Try again."],
  ])("maps %s / %s", (status, code, message) => {
    expect(knowledgeProblem(new ApiError(status, code), "Couldn't save.")).toBe(
      `Couldn't save. ${message}`,
    );
  });

  it("uses the form's invalid-input message only for otherwise unhandled 400s", () => {
    expect(knowledgeProblem(new ApiError(400, "invalid"), "Failed.", "Check fields.")).toBe(
      "Check fields.",
    );
    expect(knowledgeProblem(new ApiError(500, "invalid"), "Failed.", "Check fields.")).toBe(
      "Failed. Try again.",
    );
  });

  it.each([null, undefined, new Error("network"), { status: 401, code: "forbidden" }])(
    "does not treat %s as an API error",
    (error) => {
      expect(knowledgeProblem(error, "Failed.")).toBe(
        "Failed. Something went wrong. Check your connection, then try again or reload the page.",
      );
    },
  );
});

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

describe("blankTitle", () => {
  it.each([
    ["", false],
    [" ", "Add a title."],
    ["\t\n", "Add a title."],
    ["Title", false],
    [" Title ", false],
  ])("validates %j", (title, message) => {
    expect(blankTitle(title)).toBe(message);
  });
});

describe("knowledgeEditBody", () => {
  const source = { title: "Title", visibility: "internal", kind: "markdown" } as const;
  const untouched = { source, newTitle: undefined, newVisibility: undefined, content: "" };

  it.each([
    { name: "untouched fields", changes: {}, expected: {} },
    { name: "unchanged title", changes: { newTitle: "Title" }, expected: {} },
    { name: "title whitespace", changes: { newTitle: " Title " }, expected: {} },
    { name: "new title", changes: { newTitle: " New " }, expected: { title: "New" } },
    { name: "blank title", changes: { newTitle: " " }, expected: { title: "" } },
    { name: "same visibility", changes: { newVisibility: "internal" as const }, expected: {} },
    {
      name: "new visibility",
      changes: { newVisibility: "public" as const },
      expected: { visibility: "public" },
    },
    { name: "blank content", changes: { content: " \n" }, expected: {} },
    {
      name: "markdown whitespace",
      changes: { content: " New text\n" },
      expected: { content: " New text\n" },
    },
    {
      name: "URL content",
      changes: { source: { ...source, kind: "url" as const }, content: "Text" },
      expected: {},
    },
    {
      name: "current title whitespace",
      changes: { source: { ...source, title: " Title " }, newTitle: "Title" },
      expected: {},
    },
    {
      name: "someone else's title",
      changes: { source: { ...source, title: "Other" }, newVisibility: "public" as const },
      expected: { visibility: "public" },
    },
    {
      name: "all edited fields",
      changes: { newTitle: "New", newVisibility: "public" as const, content: "Text" },
      expected: { title: "New", visibility: "public", content: "Text" },
    },
  ])("sends only $name", ({ changes, expected }) => {
    expect(knowledgeEditBody({ ...untouched, ...changes })).toEqual(expected);
  });
});

describe("knowledgeChangedMeanwhile", () => {
  const opened = {
    title: "Title",
    visibility: "internal",
    status: "ready",
    updatedAt: "old",
  } as const;

  it.each([
    { name: "unchanged source", changes: {}, changed: false },
    { name: "new title", changes: { title: "New" }, changed: true },
    { name: "new visibility", changes: { visibility: "public" as const }, changed: true },
    {
      name: "pending with same timestamp",
      changes: { status: "pending" as const },
      changed: false,
    },
    {
      name: "new ingestion",
      changes: { status: "pending" as const, updatedAt: "new" },
      changed: true,
    },
    { name: "finished ingestion", changes: { updatedAt: "new" }, changed: false },
    {
      name: "failed ingestion",
      changes: { status: "failed" as const, updatedAt: "new" },
      changed: false,
    },
  ])("warns about $name only before a save succeeds", ({ changes, changed }) => {
    for (const mutationStatus of ["idle", "error", "pending", "success"] as const) {
      expect(
        knowledgeChangedMeanwhile({ source: { ...opened, ...changes }, opened, mutationStatus }),
        mutationStatus,
      ).toBe((mutationStatus === "idle" || mutationStatus === "error") && changed);
    }
  });
});
