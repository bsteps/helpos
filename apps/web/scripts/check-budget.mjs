// Fails the build when the dashboard's initial JavaScript is over budget (ADR 0006).
// "Initial" means what index.html loads before anything else: its module scripts and every
// chunk they import statically (modulepreload links). Lazy chunks load later and don't count.
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const budgetBytes = 200 * 1024;
const dist = new URL("../dist/", import.meta.url);
const html = readFileSync(new URL("index.html", dist), "utf8");

const files = new Set();
for (const match of html.matchAll(
  /<(?:script|link)\b[^>]*?(?:src|href)="\/(assets\/[^"]+\.js)"/g,
)) {
  const path = match[1];
  if (path) files.add(path);
}
if (files.size === 0) {
  process.stderr.write("check-budget: found no scripts in dist/index.html\n");
  process.exit(1);
}

let total = 0;
for (const file of files) {
  const size = gzipSync(readFileSync(new URL(file, dist)), { level: 9 }).length;
  total += size;
  process.stdout.write(`  ${file}: ${(size / 1024).toFixed(1)} KB gzipped\n`);
}
const summary = `${(total / 1024).toFixed(1)} KB of ${budgetBytes / 1024} KB`;
if (total > budgetBytes) {
  process.stderr.write(`Dashboard initial JS is over budget: ${summary} (ADR 0006).\n`);
  process.exit(1);
}
process.stdout.write(`Dashboard initial JS: ${summary} gzipped. Within budget.\n`);
