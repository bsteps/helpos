// `pnpm test:scripts`: the verify helpers' pure parts, so a broken fix fails here in seconds
// instead of in a hand test. No app, database or network: what needs those is app:selftest.
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { flagArg, isQuit } from "./instance.mjs";
import { freshEmail } from "./new-email.mjs";
import { isHelposListener } from "./processes.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const options = {
  fixture: "plain",
  mailbox: "support@northwind-cycles.test",
  stamp: "12:00:00",
  messageId: "fresh-1@customer.test",
};
const sample = (headers, body = "Hello") => `${headers.join("\r\n")}\r\n\r\n${body}\r\n`;
const headersOf = (raw) => raw.slice(0, raw.indexOf("\r\n\r\n")).split("\r\n");
const bodyOf = (raw) => raw.slice(raw.indexOf("\r\n\r\n") + 4);

test("freshEmail: a sample without a Message-ID gets one, so it is never a duplicate", () => {
  const { raw } = freshEmail(sample(["From: a@b.test", "Subject: Hi"]), options);
  assert.ok(headersOf(raw).includes("Message-ID: <fresh-1@customer.test>"));
});

test("freshEmail: an old Message-ID is replaced, not kept beside the new one", () => {
  const { raw } = freshEmail(sample(["Message-ID: <old@x>", "Subject: Hi"]), options);
  assert.deepEqual(
    headersOf(raw).filter((h) => /^Message-ID:/i.test(h)),
    ["Message-ID: <fresh-1@customer.test>"],
  );
});

test("freshEmail: a wrapped Subject is replaced whole, with a time to make it unique", () => {
  const { raw, sent } = freshEmail(
    sample(["Subject: A subject that wraps", " onto a second line", "From: a@b.test"]),
    options,
  );
  assert.equal(sent, "A subject that wraps onto a second line 12:00:00");
  assert.ok(!raw.includes(" onto a second line\r\n"), "the folded line is gone");
  assert.ok(headersOf(raw).includes("From: a@b.test"));
});

test("freshEmail: the demo mailbox replaces support@acme.test", () => {
  const { raw } = freshEmail(sample(["To: support@acme.test", "Subject: Hi"]), options);
  assert.ok(headersOf(raw).includes("To: support@northwind-cycles.test"));
});

test("freshEmail: with the plain sample, --subject alone is also the body", () => {
  const { raw, sent } = freshEmail(
    sample(["Subject: Old", "Content-Type: text/plain"], "I cannot log in"),
    { ...options, subject: "How much is gift wrap?" },
  );
  assert.equal(sent, "How much is gift wrap?");
  assert.equal(bodyOf(raw), "How much is gift wrap?\r\n");
});

test("freshEmail: --body is UTF-8 text, whatever the sample's charset, encoding or folding", () => {
  const { raw } = freshEmail(
    sample(
      [
        "Subject: Hi",
        "Content-Type: text/plain;",
        " charset=iso-8859-1",
        "Content-Transfer-Encoding: base64",
      ],
      "SGVsbG8=",
    ),
    { ...options, fixture: "custom", body: "Grüße" },
  );
  const headers = headersOf(raw);
  assert.ok(headers.includes("Content-Type: text/plain; charset=utf-8"));
  assert.ok(headers.includes("Content-Transfer-Encoding: 8bit"));
  assert.ok(!raw.includes("iso-8859-1") && !raw.includes("base64"), "the old ones are gone whole");
  assert.equal(bodyOf(raw), "Grüße\r\n");
});

test("freshEmail: refuses what would make a broken email", () => {
  assert.throws(
    () => freshEmail(sample(["Subject: Hi"]), { ...options, subject: "two\r\nCc: x@y.test" }),
    /one line/,
  );
  assert.throws(() => freshEmail("Subject: Hi\r\nno blank line", options), /no blank line/);
  assert.throws(
    () =>
      freshEmail(sample(["Subject: Hi", "Content-Type: multipart/mixed; boundary=x"]), {
        ...options,
        body: "text",
      }),
    /single-part text\/plain/,
  );
});

// Command lines as Windows reported them for a real `pnpm dev` of this checkout.
const webVite = `node "${join(repoRoot, "apps", "web", "node_modules", ".bin", "..", "vite", "bin", "vite.js")}" --port 21708`;
const server =
  '"C:\\Program Files\\nodejs\\node.exe" --use-largepages=off --env-file-if-exists=../../.env --stack-trace-limit=10 src/main.ts';

test("isHelposListener: this checkout's API and dashboard", () => {
  assert.equal(isHelposListener(server), true);
  assert.equal(isHelposListener(server.replace("src/main.ts", "src\\main.ts")), true);
  assert.equal(isHelposListener(webVite), true);
});

test("isHelposListener: not another project's server or Vite", () => {
  assert.equal(isHelposListener("node src/main.ts"), false, "no ../../.env flag");
  assert.equal(
    isHelposListener('node "C:\\other\\app\\node_modules\\vite\\bin\\vite.js" --port 21708'),
    false,
  );
  assert.equal(isHelposListener("vite --port 21708"), false, "a bare vite names no checkout");
  assert.equal(isHelposListener(""), false);
});

/** Runs a flagArg call that is expected to stop the script, then undoes the exit code it set. */
function stops(fn) {
  try {
    fn();
  } catch (error) {
    process.exitCode = undefined;
    return isQuit(error);
  }
  return false;
}

test("flagArg: the value after the flag, or undefined when the flag isn't there", () => {
  assert.equal(flagArg(["--subject", "Hi", "x"], "--subject"), "Hi");
  assert.equal(flagArg(["x"], "--subject"), undefined);
});

test("flagArg: a missing value, or another flag in its place, stops the script", () => {
  assert.equal(
    stops(() => flagArg(["--subject"], "--subject")),
    true,
  );
  assert.equal(
    stops(() => flagArg(["--subject", "--body", "x"], "--subject")),
    true,
  );
});

test("flagArg: a secret may start with dashes when the caller allows it", () => {
  assert.equal(flagArg(["--secret", "--x9"], "--secret", { anyValue: true }), "--x9");
});
