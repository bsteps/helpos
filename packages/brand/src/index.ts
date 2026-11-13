/**
 * The product's identity, in one place.
 *
 * Code and UI must read the name from here, never hardcode it.
 */
export const brand = {
  /** Display name shown in the UI, emails and docs. */
  name: "HelpOS",
  /** Lowercase identifier for CLIs, Docker images, env var prefixes. */
  slug: "helpos",
  /** Public source repository (AGPL-3.0 §13 "Source" link points here). */
  repositoryUrl: "https://github.com/bsteps/helpos",
} as const;
