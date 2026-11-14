#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(skillDir, "../../..");
const modelDir = join(skillDir, "model");
const workDir = join(repoRoot, ".helpos", "verify-gate");

// The same pinned jar as verify-send-reply, so one download serves both checks.
const tla = {
  version: "1.7.4",
  sha256: "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88",
};
const jar = join(repoRoot, ".helpos", "tools", `tla2tools-${tla.version}.jar`);

const invariants = [
  "OneWriter",
  "LatestVersionOnly",
  "ApprovedMeansThatAction",
  "NoAutomaticResend",
  "OnlyPeopleApprove",
];

const constants = {
  Agents: '{"a1", "a2"}',
  People: '{"p1"}',
  Payloads: '{"x", "y"}',
  MaxTime: "2",
  ClaimTTL: "2",
  MaxClaims: "2",
  MaxMessages: "1",
  MaxProposals: "2",
  MaxTampers: "1",
  MaxResends: "1",
};

const problems = [];

await ensureTlc();
const started = Date.now();
const results = await runAll();
report(results, Date.now() - started);
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

function mutants() {
  const dir = join(modelDir, "mutants");
  return readdirSync(dir)
    .filter((file) => file.endsWith(".tla"))
    .sort()
    .map((file) => {
      const text = readFileSync(join(dir, file), "utf8").replaceAll("\r\n", "\n");
      const breaks =
        text
          .match(/^\\\* breaks: (.*)$/m)?.[1]
          .trim()
          .split(/\s+/) ?? [];
      const definitions = text
        .split(/\n\s*\n/)
        .map((chunk) => chunk.trim())
        .filter((chunk) => chunk && !chunk.startsWith("\\*"));
      return { name: file.replace(/\.tla$/, ""), breaks, definitions };
    });
}

function applyMutant(spec, mutant) {
  let mutated = spec;
  for (const definition of mutant.definitions) {
    const name = definition.match(/^(\w+)/)?.[1];
    const existing = new RegExp(`^${name}(\\(.*?\\))? ==[\\s\\S]*?(?=\\n\\s*\\n)`, "m");
    if (!name || !existing.test(mutated)) {
      problems.push(`Mutant ${mutant.name}: Gate.tla has no operator ${name} to replace.`);
      return undefined;
    }
    mutated = mutated.replace(existing, definition);
  }
  if (mutated === spec) {
    problems.push(`Mutant ${mutant.name} changes nothing in Gate.tla.`);
    return undefined;
  }
  return mutated;
}

async function runAll() {
  rmSync(workDir, { recursive: true, force: true });
  const spec = readFileSync(join(modelDir, "Gate.tla"), "utf8").replaceAll("\r\n", "\n");
  const jobs = [{ group: "base", dir: "base", spec, invariants, expected: "holds" }];
  for (const mutant of mutants()) {
    const unknown = mutant.breaks.filter((name) => !invariants.includes(name));
    if (mutant.breaks.length === 0 || unknown.length > 0) {
      problems.push(
        `Mutant ${mutant.name}: its "\\* breaks:" header must name invariants from ${invariants.join(", ")}.`,
      );
      continue;
    }
    const mutated = applyMutant(spec, mutant);
    if (!mutated) continue;
    for (const invariant of mutant.breaks) {
      jobs.push({
        group: `mutant ${mutant.name}`,
        dir: join(mutant.name, invariant),
        spec: mutated,
        invariants: [invariant],
        expected: "broken",
      });
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
  const dir = join(workDir, job.dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "Gate.tla"), job.spec);
  const cfg = [
    "SPECIFICATION Spec",
    "CONSTANTS",
    ...Object.entries(constants).map(([k, v]) => `  ${k} = ${v}`),
    `INVARIANTS TypeOK ${job.invariants.join(" ")}`,
    "CHECK_DEADLOCK FALSE",
    "",
  ].join("\n");
  writeFileSync(join(dir, "Gate.cfg"), cfg);
  const args = [
    `-Djava.io.tmpdir=${dir}`,
    "-Xmx1g",
    "-XX:+UseParallelGC",
    "-cp",
    jar,
    "tlc2.TLC",
    "-config",
    "Gate.cfg",
    "-workers",
    "1",
    "-nowarning",
    "-metadir",
    join(dir, "states"),
    "Gate.tla",
  ];
  const start = Date.now();
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
      const seconds = ((Date.now() - start) / 1000).toFixed(1);
      const states = [...out.matchAll(/([\d,]+) distinct states found/g)].at(-1)?.[1];
      const violated = out.match(/Invariant (\w+) is violated/)?.[1];
      if (code === 0 && out.includes("No error has been found")) {
        done({ outcome: "holds", states, seconds, dir });
      } else if (violated) {
        const path = [...out.matchAll(/^State \d+: <(\w+)/gm)].map((m) => m[1]);
        done({ outcome: "broken", violated, path, states, seconds, dir });
      } else {
        done({ outcome: "error", dir, tail: out.trim().split("\n").slice(-6).join("\n") });
      }
    });
  });
}

function report(results, elapsed) {
  const say = (line = "") => process.stdout.write(`${line}\n`);
  for (const r of results) {
    say(`\n${r.group}`);
    const where = relative(repoRoot, r.dir).replaceAll("\\", "/");
    if (r.outcome === "error") {
      problems.push(`${r.group}: TLC did not finish. See ${where}/tlc.out`);
      say(`  !! TLC ERROR\n${r.tail.replace(/^/gm, "      ")}`);
      continue;
    }
    const facts = `${r.states} states, ${r.seconds}s`;
    if (r.outcome === "holds") {
      const ok = r.expected === "holds";
      say(`  ${ok ? "ok" : "!!"} ${["TypeOK", ...r.invariants].join(", ")}: hold, ${facts}`);
      if (!ok) {
        problems.push(
          `${r.group} no longer breaks ${r.invariants.join(", ")}: the check can no longer see that break. Fix the model, not the mutant.`,
        );
      }
      continue;
    }
    const ok = r.expected === "broken" && r.violated === r.invariants[0];
    say(`  ${ok ? "ok" : "!!"} ${r.violated}: broken, ${facts}`);
    say(`      ${r.path.join(" -> ")}`);
    if (ok) continue;
    if (r.expected === "holds") {
      problems.push(
        `${r.violated} is broken in the base model. Read ${where}/tlc.out with /statechart before you decide whether the design or the model is wrong.`,
      );
    } else {
      problems.push(
        `${r.group} broke ${r.violated}, not ${r.invariants[0]}. Read ${where}/tlc.out with /statechart: the mutant hits a different promise first.`,
      );
    }
  }
  say();
  if (problems.length === 0) {
    say(
      `Every promise holds, and every mutant breaks its promise (${(elapsed / 1000).toFixed(1)}s).`,
    );
    return;
  }
  for (const problem of problems) say(`!! ${problem}`);
}
