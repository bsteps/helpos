// Stops the HelpOS server and dashboard that launch.mjs started for this checkout, and nothing
// else: a process on our ports that launch.mjs didn't record is left running and reported.
// Exits 1 if a port is still held afterwards. Leaves the database and the evidence alone.
//   node .claude/skills/verify-helpos/scripts/cleanup.mjs
import { rmSync } from "node:fs";
import { instance, launchedPids, launchRecord } from "./instance.mjs";
import { helposChain, listeners, refreshProcesses, stopTree } from "./processes.mjs";

const inst = instance();
const ours = launchedPids();
const ports = [inst.apiUrl, inst.webUrl].map((u) => Number(new URL(u).port));
let ok = true;

// Stopping one port's tree can end the other's parents and orphan its listener, so each pass
// reads the processes afresh. A second pass stops a recorded listener a stale parent left behind.
for (let pass = 0; pass < 2; pass++) {
  for (const port of ports) {
    refreshProcesses();
    for (const l of listeners(port)) {
      // Only the part of the chain launch.mjs recorded: never a parent above its own tree.
      const recorded = helposChain(l.pid).filter((pid) => ours.has(pid));
      if (!l.helpos || recorded.length === 0) {
        if (pass === 0) {
          process.stdout.write(
            `port ${port}: pid ${l.pid} was not started by launch.mjs, left running: ${l.cmd.slice(0, 100)}\n`,
          );
        }
        ok = false;
        continue;
      }
      process.stdout.write(`port ${port}: stopping pid ${stopTree(recorded.at(-1))}\n`);
    }
  }
  await new Promise((r) => setTimeout(r, 1500));
}
refreshProcesses();
for (const port of ports) {
  const still = listeners(port);
  if (still.length > 0) {
    process.stdout.write(`port ${port}: STILL HELD by pid ${still.map((l) => l.pid).join(",")}\n`);
    ok = false;
  } else {
    process.stdout.write(`port ${port}: free\n`);
  }
}
if (ok) rmSync(launchRecord, { force: true });
process.exitCode = ok ? 0 : 1;
