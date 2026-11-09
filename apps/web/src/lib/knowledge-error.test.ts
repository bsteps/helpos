import { describe, expect, it } from "vitest";
import { knowledgeErrorMessage } from "./knowledge-error.ts";

describe("knowledgeErrorMessage", () => {
  it("names a missing page by its HTTP status", () => {
    expect(knowledgeErrorMessage("http_404")).toBe("The page wasn't found (HTTP 404).");
  });

  it("names any other HTTP failure by its status", () => {
    expect(knowledgeErrorMessage("http_503")).toBe("The site answered with an error (HTTP 503).");
  });

  it("keeps a code it doesn't know, so the owner can still report it", () => {
    expect(knowledgeErrorMessage("ingest_error")).toBe("Reading it failed (ingest_error).");
  });
});
