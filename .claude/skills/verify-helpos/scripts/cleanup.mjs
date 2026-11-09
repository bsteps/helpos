// Stops the HelpOS server and dashboard that launch.mjs started for this checkout, and nothing
// else: a process on our ports that launch.mjs didn't record is left running and reported.
// Exits 1 if a port is still held afterwards. Leaves the database and the evidence alone.
//   node .claude/skills/verify-helpos/scripts/cleanup.mjs
import { rmSync } from "node:fs";
import { instance, launchedPids, launchRecord } from "./instance.mjs";
import { helposChain, listeners, stopChain } from "./processes.mjs";

const inst = instance();
const ours = launchedPids();
const ports = [inst.apiUrl, inst.webUrl].map((u) => Number(new URL(u).port));
let ok = true;

for (const port of ports) {
  const found = listeners(port);
  if (found.length === 0) process.stdout.write(`port ${port}: free\n`);
  for (const l of found) {
    const chain = helposChain(l.pid);
    if (!l.helpos || !chain.some((pid) => ours.has(pid))) {
      process.stdout.write(
        `port ${port}: pid ${l.pid} was not started by launch.mjs, left running: ${l.cmd.slice(0, 100)}\n`,
      );
      ok = false;
      continue;
    }
    process.stdout.write(`port ${port}: stopping pid ${stopChain(chain)}\n`);
  }
}

await new Promise((r) => setTimeout(r, 1500));
for (const port of ports) {
  const still = listeners(port);
  if (still.length > 0) {
    process.stdout.write(`port ${port}: STILL HELD by pid ${still.map((l) => l.pid).join(",")}\n`);
    ok = false;
  }
}
if (ok) rmSync(launchRecord, { force: true });
process.exitCode = ok ? 0 : 1;
