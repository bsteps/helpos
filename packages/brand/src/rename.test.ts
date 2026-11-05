import { describe, expect, it } from "vitest";
import { isProtectedPath, isValidBrandName, renameText } from "./rename.ts";

describe("renameText", () => {
  it("renames the display name, slug and env prefix", () => {
    const text = "HelpOS uses @helpos/brand and HELPOS_DATABASE_URL";
    expect(renameText(text, "HelpOS", "Zentro")).toBe(
      "Zentro uses @zentro/brand and ZENTRO_DATABASE_URL",
    );
  });

  it("leaves repository URLs untouched", () => {
    const text = "Source: https://github.com/bsteps/helpos (HelpOS)";
    expect(renameText(text, "HelpOS", "Zentro")).toBe(
      "Source: https://github.com/bsteps/helpos (Zentro)",
    );
  });

  it("returns the text unchanged when the name does not appear", () => {
    expect(renameText("nothing to see", "HelpOS", "Zentro")).toBe("nothing to see");
  });
});

describe("isProtectedPath", () => {
  it.each(["LICENSE", "CLA.md", "CODE_OF_CONDUCT.md", "pnpm-lock.yaml", "docs/adr/0001-x.md"])(
    "protects %s",
    (path) => {
      expect(isProtectedPath(path)).toBe(true);
    },
  );

  it("handles Windows-style separators", () => {
    expect(isProtectedPath("docs\\adr\\0002-tech-stack.md")).toBe(true);
  });

  it("allows ordinary files", () => {
    expect(isProtectedPath("README.md")).toBe(false);
  });
});

describe("isValidBrandName", () => {
  it("accepts simple identifiers and rejects anything else", () => {
    expect(isValidBrandName("Zentro2")).toBe(true);
    expect(isValidBrandName("2Zentro")).toBe(false);
    expect(isValidBrandName("Zen tro")).toBe(false);
    expect(isValidBrandName("zen-tro")).toBe(false);
  });
});
