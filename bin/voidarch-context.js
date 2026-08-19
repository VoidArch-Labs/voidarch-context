#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

// Script filenames keep their historical dfc-/nox- prefixes (internal only);
// the public command surface below is the product API.
const tsCommands = new Map([
  ["init", "scripts/nox-init.ts"],
  ["ingest", "scripts/dfc-ingest-repo.ts"],
  ["search", "scripts/dfc-docs-query.ts"],
  ["query", "scripts/dfc-graph-query.ts"],
  ["context", "scripts/dfc-context-pack.ts"],
  ["status", "scripts/dfc-status.ts"],
  ["serve", "scripts/dfc-nox.ts"],
  ["page", "scripts/dfc-nox.ts"], // deprecated alias of `serve`
  ["remember", "scripts/dfc-remember.ts"],
  ["memory", "scripts/dfc-memory.ts"],
  ["knowledge", "scripts/dfc-knowledge.ts"],
  ["task", "scripts/dfc-task.ts"],
  ["blocker", "scripts/dfc-blocker.ts"],
  ["metrics", "scripts/dfc-metrics.ts"],
  ["sync", "scripts/dfc-sync.ts"],
  ["embed", "scripts/dfc-embed.ts"],
  ["snippets", "scripts/nox-snippets.ts"],
  ["docs:ingest", "scripts/dfc-docs-ingest.ts"],
  ["docs:query", "scripts/dfc-docs-query.ts"],
  ["graph:build", "scripts/dfc-graph-build.ts"],
  ["graph:import", "scripts/dfc-graph-import.ts"],
  ["graph:query", "scripts/dfc-graph-query.ts"],
  ["graph:status", "scripts/dfc-graph-status.ts"],
  ["memory:doctor", "scripts/dfc-memory-doctor.ts"],
  ["memory:gc", "scripts/dfc-memory-gc.ts"],
  ["db:check", "scripts/dfc-db-check.ts"],
  ["db:status", "scripts/dfc-db-check.ts"],
  ["db:migrate", "scripts/dfc-db-migrate.ts"],
  ["doctor", "scripts/dfc-memory-doctor.ts"],
  ["models:status", "scripts/nox-models.ts"],
  ["models:install", "scripts/nox-models.ts"],
  ["config:embedding", "scripts/nox-config-embedding.ts"],
]);

// `voidarch-context models <status|install>` takes its subcommand as a bare
// positional (status/install), which resolveCommand strips into `command` (e.g.
// "models:status") — put it back as args[0] for that script. `config embedding
// <choice>` doesn't need this: "embedding" is a fixed literal (not itself the
// choice), so nox-config-embedding.ts reads the choice directly from its own
// remaining argv.
const RAW_SUBCOMMAND_SCRIPTS = new Set(["scripts/nox-models.ts"]);

const grouped = new Map([
  ["docs", new Set(["ingest", "query"])],
  ["graph", new Set(["build", "import", "query", "status"])],
  ["db", new Set(["check", "status", "migrate"])],
  ["models", new Set(["status", "install"])],
  ["config", new Set(["embedding"])],
]);

function help() {
  console.log(`voidarch-context — local repo memory, query, and context-pack CLI

Usage:
  voidarch-context <command> [options]
  voidarch-context <group> <subcommand> [options]

Setup:
  init                                     write .voidarch/config.json + .gitignore entries
  models <status|install>                  local embedding model state / warm the cache (keyless)
  config embedding <local|openai-compatible>
  doctor                                   health report across all memory channels

Core:
  ingest                                   index the repo (files, symbols, docs)
  search "<query>"                         rank document chunks for a query
  query "<query>"                          rank code-graph nodes + neighborhood edges
  context "<task>" [--format markdown|json] [--max-tokens <n>]
                    [--no-include-memory] [--no-include-graph]
                    (markdown is the default format for this bin)
  status                                   counts + freshness across all channels
  serve                                    local info/search/context page (http)
  snippets                                 Claude Code slash-command + AGENTS.md snippets

Memory:
  remember --kind <decision|evidence|lesson|snippet|repo_fact|task_note> "..."
  memory <add|list|search|get|update|delete>
  task <add|list|update|done|get|delete>
  blocker <add|list|resolve|get|delete>
  knowledge <entity-upsert|entity-search|episode-add|episode-search|fact-assert|fact-list|fact-review>
  memory doctor
  memory gc

Docs / graph / vectors:
  docs <ingest|query>
  graph <build|import|query|status>
  embed [--dry-run] [--limit <n>] [--approve]

Ops:
  db <status|check|migrate>
  metrics [--days <n>] [--json]
  sync
`);
}

function resolveCommand(argv) {
  const [first, second, ...rest] = argv;
  if (!first || first === "help" || first === "--help" || first === "-h") return null;
  if (first.startsWith("dfc:")) return [first.slice(4), [second, ...rest].filter(Boolean)]; // deprecated legacy prefix
  if (first === "memory" && (second === "doctor" || second === "gc")) return [`memory:${second}`, rest];
  if (grouped.get(first)?.has(second)) return [`${first}:${second}`, rest];
  return [first, [second, ...rest].filter(Boolean)];
}

function run(script, args) {
  const tsxCli = require.resolve("tsx/cli");
  const child = spawn(process.execPath, [tsxCli, join(root, script), ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
  child.on("error", (err) => {
    console.error(err.message);
    process.exit(1);
  });
}

const resolved = resolveCommand(process.argv.slice(2));
if (!resolved) {
  help();
  process.exit(0);
}

const [command, args] = resolved;
const script = tsCommands.get(command);
if (!script) {
  console.error(`Unknown voidarch-context command: ${command}`);
  console.error("Run `voidarch-context help` for the command surface.");
  process.exit(2);
}

// models/config scripts read their own subcommand (status/install, embedding <choice>)
// as a bare positional, not a --flag; resolveCommand already stripped it into
// `command` (e.g. "models:status"), so put it back as args[0] for those scripts.
let finalArgs = args;
if (RAW_SUBCOMMAND_SCRIPTS.has(script)) {
  const sub = command.split(":")[1];
  finalArgs = [sub, ...args];
}

// UX: `context "<task>"`, `remember --kind X "<text>"`, `search "<q>"`, and
// `query "<q>"` take a bare positional instead of --task/--text/--q, which may be
// followed by more --flags (e.g. --repo-root). Find the one arg that isn't a
// "--flag" and isn't the value immediately following a preceding "--flag", and
// map it onto the flag the underlying script expects.
const POSITIONAL_FLAG = { context: "--task", remember: "--text", search: "--q", query: "--q" };
const positionalFlag = POSITIONAL_FLAG[command];
if (positionalFlag && finalArgs.length && !finalArgs.includes(positionalFlag)) {
  let positionalIndex = -1;
  let i = 0;
  while (i < finalArgs.length) {
    if (finalArgs[i].startsWith("--")) {
      i += 2; // skip this flag and its value
      continue;
    }
    positionalIndex = i;
    break;
  }
  if (positionalIndex !== -1) {
    finalArgs = [...finalArgs.slice(0, positionalIndex), positionalFlag, finalArgs[positionalIndex], ...finalArgs.slice(positionalIndex + 1)];
  }
}

// `voidarch-context context` defaults to Markdown (markdown-first for the CLI bin);
// JSON stays the default for the underlying script so Studio dashboards/skills
// calling it directly stay unchanged.
if (command === "context" && !finalArgs.includes("--format")) {
  finalArgs = [...finalArgs, "--format", "markdown"];
}

run(script, finalArgs);
