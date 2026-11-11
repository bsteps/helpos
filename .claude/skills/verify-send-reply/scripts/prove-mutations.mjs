import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const send = "apps/server/src/drafts/send-worker.ts";
const lifecycle = "apps/server/src/drafts/lifecycle.ts";
const test = "src/drafts/send-invariants.int.test.ts";
const evidence = resolve(root, ".helpos/send-mutations");
mkdirSync(evidence, { recursive: true });
const clean = spawnSync("git", ["status", "--porcelain", "--", send, lifecycle], {
  cwd: root,
  encoding: "utf8",
});
if (clean.status !== 0 || clean.stdout.trim())
  throw new Error("Covered source must be clean before scratch mutations.");
const originals = new Map(
  [send, lifecycle].map((file) => [file, readFileSync(resolve(root, file))]),
);
for (const [file, bytes] of originals)
  writeFileSync(resolve(evidence, file.split("/").at(-1)), bytes);

function replace(source, before, after) {
  if (!source.includes(before)) throw new Error(`Mutation no longer matches source: ${before}`);
  return source.replace(before, after);
}

const variants = [
  {
    name: "give-up-does-nothing",
    file: send,
    properties: ["NoSilentStall"],
    mutate: (source) =>
      replace(
        source,
        "await markSendFailed(tx, auditorFor(payload.tenantId, sendWorkerActor), payload.draftId);",
        "return;",
      ),
  },
  {
    name: "give-up-overwrites-sent",
    file: lifecycle,
    properties: ["NoHiddenDelivery"],
    mutate: (source) =>
      replace(
        source,
        'markSendFailed: { from: ["approved"]',
        'markSendFailed: { from: ["approved", "sent"]',
      ),
  },
  {
    name: "send-before-validation",
    file: send,
    properties: ["NoResendWithoutPerson", "SentOnlyWhenApproved"],
    mutate: (source) => {
      let changed = replace(source, 'if (draft.status === "sent") return;', "");
      changed = replace(
        changed,
        'draft.status !== "approved" || ',
        '(draft.status !== "approved" && draft.status !== "sent") || ',
      );
      const smtp = "await deps.transport.send({ from: row.mailbox, to: [email.to], raw });";
      changed = replace(changed, smtp, "");
      return replace(
        changed,
        "const raw = await buildReply(email);",
        `const raw = await buildReply(email);\n    ${smtp}`,
      );
    },
  },
];

function run(name, properties, broken) {
  const filter = properties.length ? ` -t "${properties.join("|")}"` : "";
  const result = spawnSync(`pnpm --filter @helpos/server exec vitest run ${test}${filter}`, {
    cwd: root,
    shell: true,
    encoding: "utf8",
    timeout: 180_000,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  writeFileSync(resolve(evidence, `${name}.log`), output);
  if (result.error || result.status !== (broken ? 1 : 0))
    throw new Error(`${name}: unexpected test exit; see ${evidence}`);
  if (
    broken &&
    (!output.includes("AssertionError") || !output.includes(`Tests  ${properties.length} failed`))
  ) {
    throw new Error(`${name}: did not fail all intended assertions; see ${evidence}`);
  }
  process.stdout.write(
    `${name}: ${broken ? "intended assertions failed" : "all assertions passed"}\n`,
  );
}

run("baseline", [], false);
for (const variant of variants) {
  const original = originals.get(variant.file);
  try {
    writeFileSync(resolve(root, variant.file), variant.mutate(original.toString()));
    const diff = spawnSync("git", ["diff", "--", variant.file], { cwd: root, encoding: "utf8" });
    writeFileSync(resolve(evidence, `${variant.name}.patch`), diff.stdout);
    run(variant.name, variant.properties, true);
  } finally {
    writeFileSync(resolve(root, variant.file), original);
  }
}
run("restored", [], false);
