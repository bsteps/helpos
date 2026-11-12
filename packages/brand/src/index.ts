/**
 * The product's identity, in one place.
 *
 * Code and UI must read the name from here, never hardcode it.
 * To rename the product, change this file and run `pnpm rename-brand <old> <new>`
 * (that also updates package names and docs).
 */
export const brand = {
  /** Display name shown in the UI, emails and docs. */
  name: "HelpOS",
  /** Lowercase identifier for CLIs, Docker images, env var prefixes. */
  slug: "helpos",
  /** Public source repository (AGPL-3.0 §13 "Source" link points here). */
  repositoryUrl: "https://github.com/bsteps/helpos",
} as const;

export type Brand = typeof brand;

/** Prefix for all environment variables, e.g. HELPOS_DATABASE_URL. */
export const envPrefix = `${brand.slug.toUpperCase()}_`;
