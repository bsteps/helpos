import { describe, expect, it } from "vitest";
import { safeRedirect } from "./redirect.ts";

describe("safeRedirect", () => {
  it("keeps a path on this site, with its query and fragment", () => {
    expect(safeRedirect("/tickets/abc?x=1#y")).toBe("/tickets/abc?x=1#y");
    expect(safeRedirect("/")).toBe("/");
  });

  it.each([
    "https://evil.test/",
    "//evil.test/path",
    // Browsers read a backslash as a slash: this is //evil.test.
    "/\\evil.test",
    // Browsers drop tabs and newlines: these are //evil.test too.
    "/\t/evil.test",
    "/\n/evil.test",
    "javascript:alert(1)",
    "tickets/abc",
    "",
    42,
    undefined,
  ])("refuses %s", (value) => {
    expect(safeRedirect(value)).toBeUndefined();
  });
});
