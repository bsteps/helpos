// Finds and stops the HelpOS processes on this checkout's ports, and nothing else. Stopping the
// `pnpm dev` task alone is not enough on Windows: its server and Vite children keep running.
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const windows = process.platform === "win32";
const webDir = join(resolve(dirname(fileURLToPath(import.meta.url)), "../../../.."), "apps", "web");
const sameCase = windows ? (s) => s.toLowerCase() : (s) => s;

/**
 * Whether a listening process is this checkout's HelpOS: the API (`src/main.ts`, whose command
 * line carries no path; the ports are this checkout's own, derived from its path), or this
 * checkout's own Vite. Another project's Vite is not.
 */
function isHelposListener(cmd) {
  if (/src[\\/]main\.ts/.test(cmd)) return true;
  return /[\\/]vite[\\/]bin[\\/]vite\.js/.test(cmd) && sameCase(cmd).includes(sameCase(webDir));
}

/** A listener, or one of the wrappers that start it: the @helpos pnpm filters and Vite's shim. */
function isHelposCommand(cmd) {
  return isHelposListener(cmd) || /--filter @helpos[\\/]|\/c vite --port \d+$/.test(cmd);
}

function sh(file, args) {
  try {
    return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
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

function processInfo(pid) {
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
 * Stops `top` and everything below it. Pass the highest pid of a chain that launch.mjs recorded,
 * so `node --watch` can't restart the child it watches and nothing above our own tree is touched.
 */
export function stopTree(top) {
  if (windows) sh("taskkill", ["/PID", String(top), "/T", "/F"]);
  else sh("kill", ["-TERM", String(top)]);
  return top;
}
