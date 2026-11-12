const nul = String.fromCharCode(0);

/**
 * For text a person wrote (markdown, plain text): keeps indentation and spacing inside lines,
 * which code, YAML and nested lists depend on. Drops trailing spaces and keeps at most one
 * blank line between paragraphs.
 */
export function tidyAuthored(text: string): string {
  return (
    text
      .replaceAll(nul, "")
      .replaceAll(/\r\n?/g, "\n")
      // Per line, not a `[ \t]+$` regex: on a page-long run of spaces that would rescan it from
      // every position.
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .replaceAll(/\n{3,}/g, "\n\n")
      .replace(/^\n+/, "")
      .trimEnd()
  );
}
