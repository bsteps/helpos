// Judges that run on the user's Claude Code and Codex subscriptions instead of an API key.
//
// Each call runs in an empty temp directory with no API key in the environment, so the CLI uses
// the logged-in subscription. Claude Code gets CLAUDE_CODE_DISABLE_CLAUDE_MDS=1, no tools, no MCP
// servers and only local settings, so no CLAUDE.md or rule file reaches the judge (it still adds
// its built-in environment context: OS, date, account). Codex still loads the user's global
// AGENTS.md; nothing in the CLI turns that off.

import { execSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const claudeBin = process.env.EVAL_CLAUDE_BIN ?? "claude";
let codexJs = process.env.EVAL_CODEX_JS;

function codexEntry() {
  codexJs ??= join(
    execSync("npm root -g", { encoding: "utf8" }).trim(),
    "@openai",
    "codex",
    "bin",
    "codex.js",
  );
  return codexJs;
}

/** No API keys in the child's environment, so each CLI falls back to its subscription login. */
function subscriptionEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const k of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "OPENAI_API_KEY",
    "AI_API_KEY",
    "EVAL_JUDGE_API_KEY",
  ])
    delete env[k];
  return env;
}

function run(cmd, args, input, { cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      const e = new Error(`${cmd} judge timed out after ${timeoutMs / 1000}s`);
      e.failure_class = "timeout";
      reject(e);
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

/** OpenAI-style strict schema: every object closed and every property required. */
function strict(schema) {
  if (Array.isArray(schema)) return schema.map(strict);
  if (!schema || typeof schema !== "object") return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) if (k !== "$schema") out[k] = strict(v);
  if (out.type === "object" && out.properties) {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties);
  }
  return out;
}

function failed(judge, why) {
  const e = new Error(`${judge} judge failed: ${why}`);
  e.failure_class = "grader_error";
  return e;
}

/** Claude Code (`claude -p`) on the Claude subscription. */
export async function claudeJudge({ model, instructions, data, schema, timeoutMs = 240_000 }) {
  const cwd = mkdtempSync(join(tmpdir(), "judge-claude-"));
  try {
    const { code, stdout, stderr } = await run(
      claudeBin,
      [
        "-p",
        "--model",
        model,
        "--system-prompt",
        instructions,
        "--tools",
        "",
        "--strict-mcp-config",
        "--setting-sources",
        "local",
        "--no-session-persistence",
        "--output-format",
        "json",
        "--json-schema",
        JSON.stringify(strict(z.toJSONSchema(schema))),
      ],
      data,
      { cwd, env: subscriptionEnv({ CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" }), timeoutMs },
    );
    let out;
    try {
      out = JSON.parse(stdout);
    } catch {
      throw failed("claude", `exit ${code}: ${stderr.slice(0, 300) || stdout.slice(0, 300)}`);
    }
    if (out.is_error || !out.structured_output)
      throw failed("claude", String(out.result ?? "no structured output").slice(0, 300));
    if (!Object.keys(out.modelUsage ?? {}).includes(model)) {
      const e = failed(
        "claude",
        `served ${Object.keys(out.modelUsage ?? {}).join(",")}, asked ${model}`,
      );
      e.failure_class = "serving_substitution";
      throw e;
    }
    const u = out.modelUsage[model];
    return {
      output: schema.parse(out.structured_output),
      model: `sub:${model}`,
      usage: {
        input_tokens: u.inputTokens ?? 0,
        cache_read_input_tokens: u.cacheReadInputTokens ?? 0,
        cache_creation_input_tokens: u.cacheCreationInputTokens ?? 0,
        output_tokens: u.outputTokens ?? 0,
      },
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

/** Codex (`codex exec`) on the ChatGPT subscription. Codex has no system-prompt flag, so the rules lead the prompt. */
export async function codexJudge({
  model,
  effort = "medium",
  instructions,
  data,
  schema,
  timeoutMs = 300_000,
}) {
  const cwd = mkdtempSync(join(tmpdir(), "judge-codex-"));
  try {
    writeFileSync(join(cwd, "schema.json"), JSON.stringify(strict(z.toJSONSchema(schema))));
    const { code, stdout, stderr } = await run(
      process.execPath,
      [
        codexEntry(),
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "-s",
        "read-only",
        "-m",
        model,
        "-c",
        `model_reasoning_effort="${effort}"`,
        "--output-schema",
        "schema.json",
        "-o",
        "out.json",
        "--json",
        "-",
      ],
      `${instructions}\n\n${data}`,
      { cwd, env: subscriptionEnv(), timeoutMs },
    );
    let text;
    try {
      text = readFileSync(join(cwd, "out.json"), "utf8");
    } catch {
      throw failed("codex", `exit ${code}: ${stderr.slice(-300)}`);
    }
    let usage = { input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
    // Codex prints one JSON event per line; other lines are not events.
    for (const line of stdout.split("\n")) {
      if (!line.trimStart().startsWith("{")) continue;
      const ev = JSON.parse(line);
      if (ev.type === "turn.completed" && ev.usage) {
        usage = {
          input_tokens: (ev.usage.input_tokens ?? 0) - (ev.usage.cached_input_tokens ?? 0),
          cache_read_input_tokens: ev.usage.cached_input_tokens ?? 0,
          output_tokens: ev.usage.output_tokens ?? 0,
        };
      }
    }
    let parsed;
    try {
      parsed = schema.parse(JSON.parse(text));
    } catch (e) {
      throw failed("codex", `unparsable answer: ${String(e.message).slice(0, 200)}`);
    }
    return { output: parsed, model: `sub:${model}`, usage };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
