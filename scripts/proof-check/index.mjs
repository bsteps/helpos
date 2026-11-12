import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { decide } from "./decide.mjs";

const event = JSON.parse(readFileSync(process.argv[2], "utf8"));
const pr = event.pull_request;
if (
  !pr ||
  !/^[a-f0-9]{40}$/.test(pr.base?.sha) ||
  !/^[a-f0-9]{40}$/.test(pr.head?.sha) ||
  (pr.body !== null && typeof pr.body !== "string")
) {
  throw new Error("Expected a pull_request event with base/head SHAs and a body");
}
const changed = execFileSync(
  "git",
  ["diff", "--name-only", "--no-renames", "-z", `${pr.base.sha}...${pr.head.sha}`, "--"],
  { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
)
  .split("\0")
  .filter(Boolean);
const result = decide(changed, pr.body);
process.stdout.write(`Proof check ${JSON.stringify(result)}\n`);
if (result.status === "fail") process.exitCode = 1;
