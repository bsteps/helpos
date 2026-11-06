/**
 * Pure logic for renaming the product. Used by `scripts/rename-brand.mjs`.
 * Kept free of file-system access so it can be unit-tested.
 */

/** Files that must never be rewritten: legal texts and permanent decision records. */
export function isProtectedPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return (
    normalized === "LICENSE" ||
    normalized === "CODE_OF_CONDUCT.md" ||
    normalized === "CLA.md" ||
    normalized === "pnpm-lock.yaml" ||
    normalized.startsWith("docs/adr/")
  );
}

const REPO_URL = /github\.com\/[\w.-]+\/[\w.-]+/g;
const URL_PLACEHOLDER = /⟦URL(\d+)⟧/g;

/**
 * Replaces the display name, slug and env prefix forms of `oldName` with `newName`.
 * Repository URLs are left untouched: rename the GitHub repo separately.
 */
export function renameText(text: string, oldName: string, newName: string): string {
  const replacements: ReadonlyArray<readonly [string, string]> = [
    [oldName, newName],
    [oldName.toLowerCase(), newName.toLowerCase()],
    [oldName.toUpperCase(), newName.toUpperCase()],
  ];

  const urls: string[] = [];
  let next = text.replace(REPO_URL, (url) => `⟦URL${urls.push(url) - 1}⟧`);
  for (const [from, to] of replacements) next = next.split(from).join(to);
  return next.replace(URL_PLACEHOLDER, (_match, index: string) => urls[Number(index)] ?? "");
}

/** A new name must be a simple identifier, so it is safe in package names and env vars. */
export function isValidBrandName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9]*$/.test(name);
}
