import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { oasdiff } from "./oasdiff.mjs";

export function intendedBreak(body) {
  const markers = body.split(/\r?\n/).filter((line) => line.startsWith("API-Break:"));
  if (markers.length === 0) return undefined;
  if (
    markers.length !== 1 ||
    !/^API-Break: \S.{19,}$/.test(markers[0]) ||
    /<[^>]+>/.test(markers[0])
  ) {
    throw new Error(
      "Use one API-Break: line with a concrete justification of at least 20 characters.",
    );
  }
  return markers[0].slice("API-Break: ".length);
}

export function compareSpecs({ binary, base, current, justification, report }) {
  for (const [name, input] of [
    ["base", base],
    ["current", current],
  ]) {
    const validation = spawnSync(
      binary,
      ["validate", "--allow-external-refs=false", "--fail-on", "ERR", "--format", "json", input],
      { encoding: "utf8" },
    );
    if (validation.error) throw validation.error;
    if (validation.status !== 0)
      throw new Error(
        `oasdiff failed to validate ${name} spec: ${validation.stdout}${validation.stderr}`,
      );
  }
  const result = spawnSync(
    binary,
    ["breaking", "--allow-external-refs=false", "--format", "json", base, current],
    {
      encoding: "utf8",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`oasdiff failed: ${result.stderr}`);
  const findings = JSON.parse(result.stdout);
  if (!Array.isArray(findings)) throw new Error("oasdiff returned an invalid report");
  const text = `${JSON.stringify(findings, null, 2)}\n`;
  if (report) writeFileSync(report, text);
  process.stdout.write(text);
  if (findings.length && !justification)
    throw new Error(
      "Breaking API changes require the documented API-Break: justification in the PR body.",
    );
  if (findings.length)
    process.stdout.write(
      `Intended API break, still requires human review: ${JSON.stringify(justification)}\n`,
    );
  return findings;
}

export function readBaseSpec(root, baseRef) {
  const base = execFileSync(
    "git",
    ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`],
    { cwd: root, encoding: "utf8" },
  ).trim();
  const committed = execFileSync("git", ["show", `${base}:apps/web/src/api/openapi.json`], {
    cwd: root,
    encoding: "utf8",
  });
  return { base, committed };
}

export async function checkCompatibility({ root, baseRef, body = "", binary, report }) {
  const justification = intendedBreak(body);
  const { base, committed } = readBaseSpec(root, baseRef);
  const generated = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import { openApiDocument } from "./apps/server/src/openapi.ts"; process.stdout.write(JSON.stringify(await openApiDocument()));',
    ],
    { cwd: root, encoding: "utf8" },
  );
  const dir = mkdtempSync(join(tmpdir(), "helpos-contract-"));
  try {
    const before = join(dir, "base.json");
    const after = join(dir, "current.json");
    writeFileSync(before, committed);
    writeFileSync(after, generated);
    process.stdout.write(`Comparing API against PR base ${base}\n`);
    return compareSpecs({
      binary: binary ?? (await oasdiff(root)),
      base: before,
      current: after,
      justification,
      report,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const event =
    process.argv[2] === "--event" ? JSON.parse(readFileSync(process.argv[3], "utf8")) : undefined;
  const baseRef = event?.pull_request?.base?.sha ?? process.argv[2];
  if (!baseRef)
    throw new Error("Pass the actual PR base commit/ref, or run from a pull_request event.");
  const body =
    event?.pull_request?.body ?? (process.argv[3] ? readFileSync(process.argv[3], "utf8") : "");
  await checkCompatibility({
    root,
    baseRef,
    body,
    report: resolve(root, ".helpos/api-breaking.json"),
  });
}
