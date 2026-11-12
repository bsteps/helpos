import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

export function checkWidgetBudget(root) {
  const widget = join(root, "apps/widget");
  if (!existsSync(widget)) {
    return { status: "absent", message: "Widget not implemented; no actual bundle verified." };
  }
  const dist = join(widget, "dist");
  const files = readdirSync(dist, { recursive: true }).filter((file) => /\.(js|css)$/.test(file));
  if (files.length === 0) throw new Error("Widget exists but dist has no JavaScript or CSS.");
  const bytes = files.reduce(
    (total, file) => total + gzipSync(readFileSync(join(dist, file)), { level: 9 }).length,
    0,
  );
  if (bytes > 20 * 1024) throw new Error(`Widget exceeds 20 KB gzip (ADR 0006): ${bytes} bytes.`);
  return { status: "checked", bytes, files };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.stdout.write(`${JSON.stringify(checkWidgetBudget(process.cwd()))}\n`);
}
