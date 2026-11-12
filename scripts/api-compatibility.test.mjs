import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { compareSpecs, intendedBreak, readBaseSpec } from "./api-compatibility.mjs";
import { oasdiff } from "./oasdiff.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const binary = await oasdiff(root);
const dir = mkdtempSync(join(tmpdir(), "helpos-compat-tests-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const original = JSON.parse(
  readFileSync(new URL("../apps/web/src/api/openapi.json", import.meta.url), "utf8"),
);
const base = join(dir, "base.json");
writeFileSync(base, JSON.stringify(original));

function compare(change, justification) {
  const doc = structuredClone(original);
  change(doc);
  const current = join(dir, "current.json");
  const report = join(dir, "report.json");
  writeFileSync(current, JSON.stringify(doc));
  return compareSpecs({ binary, base, current, justification, report });
}

test("removing or retyping a response field fails even with a current spec", () => {
  for (const change of [
    (doc) => {
      delete doc.components.schemas.Conversation.properties.subject;
      doc.components.schemas.Conversation.required =
        doc.components.schemas.Conversation.required.filter((key) => key !== "subject");
    },
    (doc) => {
      doc.components.schemas.Conversation.properties.subject.type = "integer";
    },
  ]) {
    assert.throws(() => compare(change), /Breaking API changes require/);
    const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
    assert.ok(
      report.some(
        (finding) => finding.path === "/v1/conversations" && /subject/.test(finding.text),
      ),
    );
  }
});

test("an additive optional response field is compatible", () => {
  assert.deepEqual(
    compare((doc) => {
      doc.components.schemas.Conversation.properties.extra = { type: "string" };
    }),
    [],
  );
});

test("a new response enum value, such as an error code, is reported but compatible", () => {
  assert.deepEqual(
    compare((doc) => {
      doc.components.schemas.Error.properties.error.enum.push("brand_new_code");
    }),
    [],
  );
  const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
  assert.ok(report.some((finding) => finding.id === "response-property-enum-value-added"));
});

test("one justified body marker permits the break and retains its report", () => {
  const reason = intendedBreak(
    "## Why\nAPI-Break: conversations.get changes subject to an integer; consumers must migrate.\n",
  );
  const findings = compare((doc) => {
    doc.components.schemas.Conversation.properties.subject.type = "integer";
  }, reason);
  assert.ok(findings.length > 0);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "report.json"), "utf8")), findings);
  for (const body of [
    "API-Break:",
    "API-Break: short",
    "API-Break: <write a justification here>",
    "API-Break: A sufficiently long reason.\nAPI-Break: Another sufficiently long reason.",
  ]) {
    assert.throws(() => intendedBreak(body), /Use one API-Break/);
  }
  for (const body of [
    "A paragraph mentions API-Break: but does not mark a break.",
    "> API-Break: quoted marker is not metadata.",
    "api-break: wrong case is not metadata.",
  ]) {
    assert.equal(intendedBreak(body), undefined);
  }
});

test("a marker cannot waive a malformed spec or a tool failure", () => {
  assert.throws(
    () =>
      compare((doc) => {
        doc.paths["/v1/conversations"].get.responses["200"].content["application/json"].schema = {
          $ref: "#/components/schemas/Missing",
        };
      }, "Concretely justified intended API break."),
    /oasdiff failed/,
  );
  assert.throws(() =>
    compareSpecs({
      binary: join(dir, "absent"),
      base,
      current: base,
      justification: "A justification does not make the tool exist.",
    }),
  );
});

test("a justification cannot admit invalid base or revision documents", () => {
  const invalidSchema = structuredClone(original);
  invalidSchema.paths["/health"].get.responses["200"].content["application/json"].schema.type =
    "invalid";
  const invalid = join(dir, "invalid.json");
  for (const doc of [{}, invalidSchema]) {
    writeFileSync(invalid, JSON.stringify(doc));
    for (const side of ["base", "current"]) {
      assert.throws(
        () =>
          compareSpecs({
            binary,
            base: side === "base" ? invalid : base,
            current: side === "current" ? invalid : base,
            justification: "This reason cannot permit an invalid specification.",
          }),
        /oasdiff failed to validate/,
      );
    }
  }
});

test("external refs in either input never reach the loopback network", async () => {
  const worker = new Worker(
    `
    const { createServer } = require("node:http");
    const { parentPort } = require("node:worker_threads");
    const server = createServer((req, res) => {
      parentPort.postMessage({ kind: "request" });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "string" }));
    });
    server.listen(0, "127.0.0.1", () => {
      parentPort.postMessage({ kind: "ready", url: "http://127.0.0.1:" + server.address().port + "/schema.json" });
    });
  `,
    { eval: true },
  );
  let requests = 0;
  try {
    const [ready] = await once(worker, "message");
    worker.on("message", (message) => {
      if (message.kind === "request") requests += 1;
    });
    const external = structuredClone(original);
    external.components.schemas.Conversation.properties.subject = { $ref: ready.url };
    const input = join(dir, "external.json");
    writeFileSync(input, JSON.stringify(external));
    for (const side of ["base", "current"]) {
      assert.throws(
        () =>
          compareSpecs({
            binary,
            base: side === "base" ? input : base,
            current: side === "current" ? input : base,
            justification: "This reason cannot permit outside reference fetching.",
          }),
        /external|disallowed/i,
      );
    }
  } finally {
    await worker.terminate();
  }
  assert.equal(requests, 0);
});

test("CI compares the event's base without interpolating its body into shell code", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /node scripts\/api-compatibility.mjs --event "\$GITHUB_EVENT_PATH"/);
  assert.match(workflow, /types: \[opened, synchronize, reopened, edited, ready_for_review\]/);
  const source = readFileSync(new URL("./api-compatibility.mjs", import.meta.url), "utf8");
  assert.match(source, /event\?\.pull_request\?\.base\?\.sha/);
  assert.doesNotMatch(source, /shell:\s*true|origin\/main/);
  execFileSync(binary, ["--version"], { stdio: "pipe" });
});

test("the base loader reads the requested commit or ref rather than main or the working copy", () => {
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "apps/web/src/api"), { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Contract Test");
  git("config", "user.email", "contract@example.test");
  const spec = join(repo, "apps/web/src/api/openapi.json");
  writeFileSync(spec, "base contract");
  git("add", ".");
  git("commit", "-m", "base");
  const parent = git("rev-parse", "HEAD");
  git("branch", "source-parent");
  writeFileSync(spec, "main contract");
  git("commit", "-am", "main advances");
  assert.deepEqual(readBaseSpec(repo, "source-parent"), {
    base: parent,
    committed: "base contract",
  });
  assert.deepEqual(readBaseSpec(repo, parent), { base: parent, committed: "base contract" });
  assert.equal(readBaseSpec(repo, "main").committed, "main contract");
  assert.throws(() => readBaseSpec(repo, "missing-ref"));
});
