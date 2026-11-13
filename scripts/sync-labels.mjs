// Keeps the repo's GitHub labels in step with .github/labels.json (name, colour, description).
// It only creates and updates labels. Labels not in the file are left alone, so GitHub's
// defaults and one-off labels survive. Run by .github/workflows/labels.yml, or locally with
// `GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo node scripts/sync-labels.mjs`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const issueStates = ["needs-triage", "ready", "in-progress"];
export const prStates = ["land"];

export function loadLabels(path = new URL("../.github/labels.json", import.meta.url)) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Problems with the label list, as readable strings. Empty means valid. */
export function validateLabels(labels) {
  const problems = [];
  const seen = new Set();
  for (const label of labels) {
    // GitHub label names are case-insensitive.
    const key = String(label.name).toLowerCase();
    if (seen.has(key)) problems.push(`duplicate label: ${label.name}`);
    seen.add(key);
    if (!/^[0-9A-F]{6}$/.test(label.color))
      problems.push(`${label.name}: colour must be 6 upper-case hex digits`);
    if (!label.description || label.description.length > 100)
      problems.push(`${label.name}: description must be 1-100 characters`);
  }
  for (const name of [...issueStates, ...prStates, "needs-human"])
    if (!seen.has(name)) problems.push(`missing state label: ${name}`);
  return problems;
}

/** What to change so `existing` matches `desired`. Pure, so it is tested without the network. */
export function planSync(existing, desired) {
  const byName = new Map(existing.map((l) => [l.name.toLowerCase(), l]));
  const plan = [];
  for (const label of desired) {
    const current = byName.get(label.name.toLowerCase());
    if (!current) plan.push({ action: "create", label });
    else if (
      current.name !== label.name ||
      current.color.toUpperCase() !== label.color ||
      (current.description ?? "") !== label.description
    )
      plan.push({ action: "update", from: current.name, label });
  }
  return plan;
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) throw new Error("GITHUB_TOKEN and GITHUB_REPOSITORY must be set");
  const desired = loadLabels();
  const problems = validateLabels(desired);
  if (problems.length) throw new Error(`invalid .github/labels.json:\n${problems.join("\n")}`);

  const api = async (path, init = {}) => {
    const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
      },
    });
    if (!res.ok)
      throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
    return res.json();
  };

  const existing = [];
  for (let page = 1; ; page++) {
    const batch = await api(`/labels?per_page=100&page=${page}`);
    existing.push(...batch);
    if (batch.length < 100) break;
  }

  for (const step of planSync(existing, desired)) {
    const { name, color, description } = step.label;
    if (step.action === "create") {
      await api("/labels", { method: "POST", body: JSON.stringify({ name, color, description }) });
    } else {
      await api(`/labels/${encodeURIComponent(step.from)}`, {
        method: "PATCH",
        body: JSON.stringify({ new_name: name, color, description }),
      });
    }
    process.stdout.write(`${step.action}d ${name}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
