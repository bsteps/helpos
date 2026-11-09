// File-system and git helpers for worktree setup, shared by `pnpm dev` and setup-worktree.mjs.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, statSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** In a linked worktree `.git` is a file pointing at the main repo; in the main checkout, a folder. */
export function isWorktree(root = process.cwd()) {
  const git = join(root, ".git");
  return existsSync(git) && statSync(git).isFile();
}

/** The main checkout's folder: the parent of the shared git directory. */
export function mainCheckoutDir(root = process.cwd()) {
  const result = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`git rev-parse failed: ${result.stderr.trim()}`);
  return dirname(resolve(result.stdout.trim()));
}

/**
 * Links the main checkout's .env into this worktree, so secrets live in one place and never get
 * committed. Windows without Developer Mode can't create symlinks; then it copies, and says so.
 * Returns what it did: "exists", "linked", "copied" or "missing" (main checkout has no .env).
 */
export function linkEnv(root = process.cwd()) {
  const target = join(root, ".env");
  if (existsSync(target) || isDanglingLink(target)) return "exists";
  const source = join(mainCheckoutDir(root), ".env");
  if (!existsSync(source)) return "missing";
  try {
    symlinkSync(source, target, "file");
    return "linked";
  } catch (error) {
    if (process.platform !== "win32") throw error;
    copyFileSync(source, target);
    return "copied";
  }
}

function isDanglingLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export const envMessages = {
  exists: ".env already present",
  linked: ".env linked from the main checkout",
  copied:
    ".env COPIED from the main checkout (this Windows account can't create symlinks; turn on " +
    "Developer Mode to link instead). Changes to the main .env won't reach this worktree.",
  missing: "the main checkout has no .env; `pnpm dev` will create one from .env.example",
};
