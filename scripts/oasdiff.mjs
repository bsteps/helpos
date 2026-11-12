import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const version = "1.37.0";
const checksums = {
  linux: "eac87307d31d08c36800c58a409c247f1c5db37fbb72e2544402f22a87cbca3c",
  win32: "d72f1c5c4ba4adddafa4ec3c38f1c34f09df8ddb2d2bdd75869f94145c5bcc6d",
};

export async function oasdiff(root) {
  if (process.arch !== "x64" || !checksums[process.platform]) {
    throw new Error("The contract check supports Linux and Windows x64.");
  }
  const dir = resolve(root, ".helpos/tools");
  mkdirSync(dir, { recursive: true });
  const archive = `oasdiff_${version}_${process.platform === "win32" ? "windows" : "linux"}_amd64.tar.gz`;
  const path = join(dir, archive);
  if (!existsSync(path)) {
    const response = await fetch(
      `https://github.com/oasdiff/oasdiff/releases/download/v${version}/${archive}`,
    );
    if (!response.ok) throw new Error(`oasdiff download failed (${response.status})`);
    writeFileSync(path, Buffer.from(await response.arrayBuffer()));
  }
  if (
    createHash("sha256").update(readFileSync(path)).digest("hex") !== checksums[process.platform]
  ) {
    throw new Error("oasdiff archive checksum mismatch");
  }
  const binary = process.platform === "win32" ? "oasdiff.exe" : "oasdiff";
  execFileSync("tar", ["-xzf", path, "-C", dir, binary]);
  return join(dir, binary);
}
