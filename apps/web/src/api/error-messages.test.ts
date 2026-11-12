import { describe, expect, it } from "vitest";
import { errorMessage } from "./error-messages.ts";

describe("public API error messages", () => {
  it("uses contextual wording before a status fallback", () => {
    expect(errorMessage("url_taken", { url_taken: "This URL already exists." }, "Try again.")).toBe(
      "This URL already exists.",
    );
  });

  it("keeps contextual fallbacks for other known codes and unknown external responses", () => {
    for (const code of ["bad_request", "external_error", "toString", "__proto__", undefined]) {
      expect(errorMessage(code, {}, "Nothing changed; try again.")).toBe(
        "Nothing changed; try again.",
      );
      expect(errorMessage(code, {})).toBe("That didn't work. Try again.");
    }
  });
});
