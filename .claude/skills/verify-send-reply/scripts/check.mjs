#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(skillDir, "../../..");
const skillFile = join(skillDir, "SKILL.md");
const modelDir = join(skillDir, "model");
const workDir = join(repoRoot, ".helpos", "verify-send-reply");

const tla = {
  version: "1.7.4",
  sha256: "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88",
};
const jar = join(repoRoot, ".helpos", "tools", `tla2tools-${tla.version}.jar`);

const properties = [
  "NoResendWithoutPerson",
  "NoHiddenDelivery",
  "NoSilentStall",
  "SentOnlyWhenApproved",
];

const constants = { Workers: "{1, 2}", RetryLimit: "1", MaxPersonRetries: "1", MaxFaults: "1" };

const runs = [
  { name: "no faults", faults: [], known: { NoSilentStall: "lost retry" } },
  { name: "lease_expires", faults: ["lease_expires"], known: { NoSilentStall: "lost retry" } },
  {
    name: "commit_fails",
    faults: ["commit_fails"],
    known: { NoSilentStall: "lost retry" },
  },
  {
    name: "smtp_reply_lost",
    faults: ["smtp_reply_lost"],
    known: { NoSilentStall: "lost retry" },
  },
  {
    name: "worker_dies",
    faults: ["worker_dies"],
    known: {
      NoSilentStall: "give-up failure / lost retry",
    },
  },
  {
    name: "give_up_fails",
    faults: ["give_up_fails"],
    known: { NoSilentStall: "give-up failure / lost retry" },
  },
];

const confirm = process.argv.includes("--confirm");
const problems = [];

await ensureTlc();
const coverage = checkCoverage();
if (confirm) {
  writeCoverage(coverage);
  process.exit(0);
}
const results = await runAll();
report(results);
process.exit(problems.length > 0 ? 1 : 0);

async function ensureTlc() {
  const java = spawnSync("java", ["-version"], { encoding: "utf8" });
  if (java.error || java.status !== 0) {
    fail("Java 11 or newer is needed on PATH to run TLC (for example Temurin 17 or 21).");
  }
  if (existsSync(jar) && sha256(readFileSync(jar)) === tla.sha256) return;
  const url = `https://github.com/tlaplus/tlaplus/releases/download/v${tla.version}/tla2tools.jar`;
  process.stdout.write(`Downloading TLC ${tla.version}...\n`);
  const response = await fetch(url);
  if (!response.ok) fail(`Downloading ${url} failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== tla.sha256) fail(`${url} does not match the pinned SHA-256.`);
  mkdirSync(dirname(jar), { recursive: true });
  writeFileSync(jar, bytes);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function coverageBlock() {
  const text = readFileSync(skillFile, "utf8").replaceAll("\r\n", "\n");
  const match = text.match(/<!-- coverage -->\n([\s\S]*?)<!-- \/coverage -->/);
  if (!match) fail("SKILL.md has no <!-- coverage --> block.");
  return { text, block: match[1] };
}

function checkCoverage() {
  const { block } = coverageBlock();
  const rows = block
    .split("\n")
    .filter(
      (line) => line.startsWith("| ") && !line.startsWith("| Module") && !/^\|\s*-/.test(line),
    )
    .map((line) => {
      const [module, symbol, steps, recorded] = line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim().replace(/^`|`$/g, ""));
      return { module, symbol, steps, recorded, line };
    });
  for (const row of rows) {
    row.current = fingerprint(row.module, row.symbol);
    if (row.current === undefined) {
      const elsewhere = findDeclarations(row.symbol.split(".").pop());
      problems.push(
        `Coverage: ${row.symbol} is not in ${row.module}. It moved or was renamed` +
          (elsewhere.length ? ` (found in ${elsewhere.join(", ")})` : "") +
          ". Find it, check the model steps it maps to, and update the coverage record.",
      );
    } else if (row.current !== row.recorded) {
      problems.push(
        `Coverage: ${row.module} ${row.symbol} changed since the model was last confirmed. ` +
          `Re-read it against the model steps ${row.steps}, then run with --confirm.`,
      );
    }
  }
  return rows;
}

function fingerprint(module, symbol) {
  if (!module.includes("/")) {
    const manifest = join(repoRoot, "packages", "db", "node_modules", module, "package.json");
    return existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")).version : undefined;
  }
  const file = join(repoRoot, module);
  if (!existsSync(file)) return undefined;
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  let node = source;
  for (const name of symbol.split(".")) {
    node = findNamed(node, name);
    if (!node) return undefined;
  }
  const printed = ts
    .createPrinter({ removeComments: true })
    .printNode(ts.EmitHint.Unspecified, node, source);
  return sha256(printed).slice(0, 12);
}

function isDeclaration(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isVariableDeclaration(node) ||
    ts.isPropertyAssignment(node) ||
    ts.isMethodDeclaration(node)
  );
}

function findNamed(root, name) {
  let found;
  const visit = (node) => {
    if (found) return;
    if (isDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.name.text === name) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(root, visit);
  return found;
}

function findDeclarations(name) {
  const hits = [];
  const declaration = new RegExp(`(function|const|let)\\s+${name}\\b|^\\s+${name}:\\s*\\{`, "m");
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") && declaration.test(readFileSync(path, "utf8"))) {
        hits.push(relative(repoRoot, path).replaceAll("\\", "/"));
      }
    }
  };
  for (const top of ["apps", "packages"]) walk(join(repoRoot, top));
  return hits;
}

function writeCoverage(rows) {
  const missing = rows.filter((row) => row.current === undefined);
  if (missing.length > 0) fail("Fix the rows whose function is missing before --confirm.");
  const files = rows.map((row) => row.module).filter((module) => module.includes("/"));
  const dirty = spawnSync("git", ["status", "--porcelain", "--", ...new Set(files)], {
    cwd: repoRoot,
    encoding: "utf8",
  }).stdout.trim();
  if (dirty) fail(`Commit the covered files first, so the record names a commit:\n${dirty}`);
  const head = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).stdout.trim();
  let { text, block } = coverageBlock();
  let updated = block.replace(
    /Last confirmed at commit `[0-9a-f]+`/,
    `Last confirmed at commit \`${head}\``,
  );
  for (const row of rows) {
    updated = updated.replace(row.line, row.line.replace(/\|[^|]*\|$/, `| \`${row.current}\` |`));
  }
  text = text.replace(block, updated);
  writeFileSync(skillFile, text);
  process.stdout.write(`Coverage record confirmed at ${head}.\n`);
}

function mutants() {
  const dir = join(modelDir, "mutants");
  return readdirSync(dir)
    .filter((file) => file.endsWith(".tla"))
    .map((file) => {
      const text = readFileSync(join(dir, file), "utf8");
      const header = (key) => text.match(new RegExp(`^\\\\\\* ${key}: (.*)$`, "m"))?.[1].trim();
      const run = header("runs with");
      const breaks = header("breaks")?.split(/\s+/) ?? [];
      const definitions = text
        .split(/\n\s*\n/)
        .map((chunk) => chunk.trim())
        .filter((chunk) => chunk && !chunk.startsWith("\\*"));
      return { name: file.replace(/\.tla$/, ""), run, breaks, definitions };
    });
}

function applyMutant(spec, mutant) {
  let mutated = spec;
  for (const definition of mutant.definitions) {
    const name = definition.match(/^(\w+)/)?.[1];
    const existing = new RegExp(`^${name}(\\(.*?\\))? ==[\\s\\S]*?(?=\\n\\s*\\n)`, "m");
    if (!name || !existing.test(mutated)) {
      problems.push(`Mutant ${mutant.name}: SendReply.tla has no operator ${name} to replace.`);
      return undefined;
    }
    mutated = mutated.replace(existing, definition);
  }
  return mutated;
}

async function runAll() {
  rmSync(workDir, { recursive: true, force: true });
  const spec = readFileSync(join(modelDir, "SendReply.tla"), "utf8");
  const jobs = [];
  for (const run of runs) {
    for (const property of properties) {
      const expected = run.known?.[property] ? "broken" : "holds";
      jobs.push({ group: run.name, run, property, spec, expected, known: run.known?.[property] });
    }
  }
  for (const mutant of mutants()) {
    const run = runs.find((r) => r.name === mutant.run);
    const spec2 = run && applyMutant(spec, mutant);
    if (!run) problems.push(`Mutant ${mutant.name}: unknown run "${mutant.run}".`);
    if (!run || !spec2) continue;
    const mutationConstants = { ...constants, MaxPersonRetries: "0" };
    for (const property of mutant.breaks) {
      const conditions = { run, property, constants: mutationConstants };
      jobs.push({ ...conditions, group: `control ${mutant.name}`, spec, expected: "holds" });
      jobs.push({ ...conditions, group: `mutant ${mutant.name}`, spec: spec2, expected: "broken" });
    }
  }
  const limit = Math.max(1, Math.min(4, availableParallelism() - 1));
  const results = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < jobs.length) {
        const index = next++;
        results[index] = { ...jobs[index], ...(await tlc(jobs[index])) };
      }
    }),
  );
  return results;
}

function tlc(job) {
  const dir = join(workDir, slug(job.group), job.property);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SendReply.tla"), job.spec);
  const cfg = [
    "SPECIFICATION Spec",
    "CONSTANTS",
    ...Object.entries(job.constants ?? constants).map(([k, v]) => `  ${k} = ${v}`),
    `  Faults = {${job.run.faults.map((f) => `"${f}"`).join(", ")}}`,
    `INVARIANTS TypeOK ${job.property}`,
    "CHECK_DEADLOCK FALSE",
    "",
  ].join("\n");
  writeFileSync(join(dir, "SendReply.cfg"), cfg);
  const args = [
    `-Djava.io.tmpdir=${dir}`,
    "-Xmx512m",
    "-XX:+UseParallelGC",
    "-cp",
    jar,
    "tlc2.TLC",
    "-config",
    "SendReply.cfg",
  ];
  args.push("-workers", "1", "-nowarning", "-metadir", join(dir, "states"), "SendReply.tla");
  return new Promise((done) => {
    const child = spawn("java", args, { cwd: dir });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      out += chunk;
    });
    child.on("close", (code) => {
      writeFileSync(join(dir, "tlc.out"), out);
      const states = out.match(/(\d+) distinct states found/)?.[1];
      if (code === 0 && out.includes("No error has been found")) {
        done({ outcome: "holds", states, dir });
      } else if (new RegExp(`Invariant ${job.property} is violated`).test(out)) {
        const path = [...out.matchAll(/^State \d+: <(\w+)/gm)].map((m) => m[1]);
        done({ outcome: "broken", path, states, dir });
      } else {
        done({ outcome: "error", dir, tail: out.trim().split("\n").slice(-6).join("\n") });
      }
    });
  });
}

function slug(text) {
  return text.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

function report(results) {
  const say = (line = "") => process.stdout.write(`${line}\n`);
  let group;
  for (const r of results) {
    if (r.group !== group) {
      group = r.group;
      say(`\n${group}`);
    }
    const where = relative(repoRoot, r.dir).replaceAll("\\", "/");
    if (r.outcome === "error") {
      problems.push(`${r.group} / ${r.property}: TLC did not finish. See ${where}/tlc.out`);
      say(`  ${r.property}: TLC ERROR\n${r.tail.replace(/^/gm, "      ")}`);
      continue;
    }
    const mark = r.outcome === r.expected ? "ok " : "!! ";
    const label =
      r.outcome === "holds" ? "holds" : `broken${r.known ? ` (known: ${r.known})` : ""}`;
    say(`  ${mark}${r.property}: ${label}${r.states ? `, ${r.states} states` : ""}`);
    if (r.outcome === "broken") say(`      ${r.path.join(" -> ")}`);
    if (r.outcome === r.expected) continue;
    if (r.group.startsWith("control")) {
      problems.push(
        `${r.group} already breaks ${r.property} without mutation. The mutant does not prove sensitivity to that change. Review the base model and control conditions.`,
      );
    } else if (r.group.startsWith("mutant")) {
      problems.push(
        `${r.group} no longer breaks ${r.property}: the check can no longer see that break. Fix the model, not the mutant.`,
      );
    } else if (r.known) {
      problems.push(
        `${r.property} now holds under ${r.group}, where it was known finding ${r.known}. If this change fixes ${r.known}, remove it from \`known\` in check.mjs. Otherwise find out what the model lost.`,
      );
    } else {
      problems.push(
        `${r.property} is broken under ${r.group}. Read ${where}/tlc.out with /statechart before you decide whether the code or the model is wrong.`,
      );
    }
  }
  say();
  if (problems.length === 0) {
    say("Every result matches the expected table, and the coverage record matches the code.");
    return;
  }
  for (const problem of problems) say(`!! ${problem}`);
}
