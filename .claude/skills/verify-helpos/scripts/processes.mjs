// Finds and stops the HelpOS processes on this checkout's ports, and nothing else. Stopping the
// `pnpm dev` task alone is not enough on Windows: its server and Vite children keep running.
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const windows = process.platform === "win32";
const webDir = join(resolve(dirname(fileURLToPath(import.meta.url)), "../../../.."), "apps", "web");

/**
 * Whether a command line is part of this checkout's HelpOS: the API (`src/main.ts`), the pnpm
 * filters that start it, or this checkout's own Vite. Any other project's Vite is not.
 */
function isHelposCommand(cmd) {
  if (/src[\\/]main\.ts|--filter @helpos[\\/]|\/c vite --port \d+$/.test(cmd)) return true;
  const sameCase = windows ? (s) => s.toLowerCase() : (s) => s;
  return /[\\/]vite[\\/]bin[\\/]vite\.js/.test(cmd) && sameCase(cmd).includes(sameCase(webDir));
}

function sh(file, args) {
  try {
    return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

function processInfo(pid) {
  if (windows) {
    const out = sh("powershell", [
      "-NoProfile",
      "-Command",
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { "$($p.ParentProcessId)"; $p.CommandLine }`,
    ]);
    const [parent, ...cmd] = out.split(/\r?\n/);
    return parent ? { pid, parent: Number(parent), cmd: cmd.join(" ").trim() } : undefined;
  }
  const out = sh("ps", ["-o", "ppid=,command=", "-p", String(pid)]).trim();
  const match = /^(\d+)\s+(.*)$/.exec(out);
  return match ? { pid, parent: Number(match[1]), cmd: match[2] } : undefined;
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
    return { pid, cmd: info?.cmd ?? "", helpos: isHelposCommand(info?.cmd ?? "") };
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
