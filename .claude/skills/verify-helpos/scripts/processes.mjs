// Finds and stops the HelpOS processes on this checkout's ports, and nothing else. Stopping the
// `pnpm dev` task alone is not enough on Windows: its server and Vite children keep running.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const windows = process.platform === "win32";
const webDir = join(resolve(dirname(fileURLToPath(import.meta.url)), "../../../.."), "apps", "web");
const sameCase = windows ? (s) => s.toLowerCase() : (s) => s;
// The file `pnpm dev` runs for the API, read from apps/server's own dev script, so a change
// there is followed here instead of making the real server look like a stranger.
function serverDevScript() {
  try {
    const dev = JSON.parse(readFileSync(join(webDir, "..", "server", "package.json"), "utf8"))
      .scripts?.dev;
    if (typeof dev === "string") return dev;
  } catch {}
  return "node --watch --env-file-if-exists=../../.env src/main.ts";
}
const serverDev = serverDevScript();
const pathPattern = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\//g, "[\\\\/]");
// The entry file and the --env-file flag together: another project's `node src/main.ts` rarely
// also loads ../../.env, so a match on both is this repo's server.
const serverMarks = [
  /\S+\.[cm]?[jt]s(?=\s|$)/.exec(serverDev)?.[0] ?? "src/main.ts",
  ...(serverDev.match(/--env-file\S*/g) ?? []),
].map((mark) => new RegExp(pathPattern(mark)));

/**
 * Whether a listening process is this checkout's HelpOS: the API (its dev script's entry file and
 * --env-file flag), or this checkout's own Vite. Another project's Vite is not.
 *
 * The API's command line carries no absolute path, and neither Windows nor ps shows a process's
 * working directory, so a stranger with the same entry and flag would still pass. That only
 * labels it in doctor, whose health and proxy checks then fail on it: launch refuses any held
 * port, and cleanup stops only pids that launch recorded below its own child.
 */
export function isHelposListener(cmd) {
  if (serverMarks.every((mark) => mark.test(cmd))) return true;
  return /[\\/]vite[\\/]bin[\\/]vite\.js/.test(cmd) && sameCase(cmd).includes(sameCase(webDir));
}

/** A listener, or one of the wrappers that start it: the @helpos pnpm filters and Vite's shim. */
function isHelposCommand(cmd) {
  return isHelposListener(cmd) || /--filter @helpos[\\/]|\/c vite --port \d+$/.test(cmd);
}

function sh(file, args) {
  try {
    // Node's 1 MB default would drop a busy machine's process list without a word.
    return execFileSync(file, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    // A non-zero exit can still have done the work (taskkill stops the tree, then fails on a
    // child that was already gone): keep what it printed.
    return typeof error?.stdout === "string" ? error.stdout : "";
  }
}

/**
 * Every process at once (pid, parent, command line), kept for a second. One PowerShell call per
 * process took about a second each on Windows, and a chain walk needs a dozen.
 */
let snapshot;
function processTable() {
  if (snapshot && Date.now() - snapshot.at < 1000) return snapshot.byPid;
  const byPid = new Map();
  const add = (pid, parent, cmd) => byPid.set(pid, { pid, parent, cmd: (cmd ?? "").trim() });
  if (windows) {
    const out = sh("powershell", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress",
    ]);
    let rows = [];
    try {
      rows = [JSON.parse(out || "[]")].flat();
    } catch {}
    for (const p of rows) add(p.ProcessId, p.ParentProcessId, p.CommandLine);
  } else {
    for (const line of sh("ps", ["-A", "-o", "pid=,ppid=,command="]).split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (match) add(Number(match[1]), Number(match[2]), match[3]);
    }
  }
  snapshot = { at: Date.now(), byPid };
  return byPid;
}

/** Forgets the snapshot, for a caller that just stopped processes and must see what's left. */
export function refreshProcesses() {
  snapshot = undefined;
}

/** A process's command line, or undefined when it isn't running. */
export function commandOf(pid) {
  return processInfo(pid)?.cmd;
}

function processInfo(pid) {
  // A process that started after the snapshot (a server just coming up) isn't in it yet.
  if (!processTable().has(pid)) refreshProcesses();
  return processTable().get(pid);
}

export function listeners(port) {
  const pids = new Set();
  if (windows) {
    // A listening socket is the one with no remote end. Neither its state nor netstat can be
    // trusted here: some Windows builds report a listening socket as Closed or blank, and
    // netstat leaves some of them out entirely.
    const out = sh("powershell", [
      "-NoProfile",
      "-Command",
      `Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Where-Object { $_.RemotePort -eq 0 } | ForEach-Object { $_.OwningProcess }`,
    ]);
    for (const pid of out.split(/\s+/)) if (Number(pid) > 0) pids.add(Number(pid));
  } else {
    for (const pid of sh("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]).split(/\s+/)) {
      if (pid) pids.add(Number(pid));
    }
  }
  return [...pids].map((pid) => {
    const info = processInfo(pid);
    return { pid, cmd: info?.cmd ?? "", helpos: isHelposListener(info?.cmd ?? "") };
  });
}

/**
 * The process and its HelpOS ancestors, nearest first. launch.mjs records these chains so cleanup
 * can tell its own processes from another checkout's or project's on the same port, even after
 * Windows orphans the server (its pnpm parent gone, the `node --watch` parent still running).
 */
export function helposChain(pid, { stopAt } = {}) {
  const chain = [pid];
  for (let i = 0; i < 8 && chain.at(-1) !== stopAt; i++) {
    const info = processInfo(chain.at(-1));
    const parent = info && processInfo(info.parent);
    if (!parent || !isHelposCommand(parent.cmd)) break;
    chain.push(parent.pid);
  }
  return chain;
}

/** Whether `pid` is `ancestor` or runs somewhere below it. */
export function descendsFrom(pid, ancestor) {
  let current = pid;
  for (let i = 0; i < 12 && current; i++) {
    if (current === ancestor) return true;
    current = processInfo(current)?.parent;
  }
  return false;
}

/**
 * Stops `top` and everything below it, and says whether that worked. Pass the highest pid of a chain that launch.mjs recorded,
 * so `node --watch` can't restart the child it watches and nothing above our own tree is touched.
 */
export function stopTree(top) {
  if (windows) {
    // taskkill prints SUCCESS for each process it stops; nothing means it couldn't.
    return /SUCCESS/i.test(sh("taskkill", ["/PID", String(top), "/T", "/F"]));
  }
  // kill signals one process, so the tree is listed first, then signalled top down: a parent
  // that restarts its child (`node --watch`) is gone before the child is.
  const all = [...processTable().values()];
  const tree = [top];
  for (let i = 0; i < tree.length; i++) {
    for (const p of all) if (p.parent === tree[i]) tree.push(p.pid);
  }
  let stopped = false;
  for (const pid of tree) {
    try {
      process.kill(pid, "SIGTERM");
      stopped = true;
    } catch {}
  }
  return stopped;
}
