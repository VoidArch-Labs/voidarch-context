// voidarch-context log-tool — append one tool_event to the local `.agent-runs` buffer.
//
//   voidarch-context log-tool --session s1 --agent codex --tool Bash --command "pnpm test"
//   voidarch-context log-tool --session s1 --tool mcp__github__get_pr --mcp-server github --mcp-tool get_pr
//   voidarch-context log-tool --session s1 --tool Write --file src/x.ts --dry-run
//
// Writes a JSONL line shape-compatible with hooks/log-agent-run.sh, so the same
// voidarch-context import-runs pass ingests Claude Code hook output AND manual/Codex events.
// No database access — this only appends to the local (gitignored) buffer.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizeSourceAgent } from "../src/agents.js";
import { parseArgs, repoRootFromArgs } from "../src/cli.js";

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const sourceAgent = normalizeSourceAgent(args.agent);
  const session = (args.session || "manual").trim();
  const tool = (args.tool || "").trim();
  if (!tool) {
    console.error("--tool is required (e.g. Bash, Write, mcp__github__get_pr)");
    process.exit(2);
  }

  const tsParts = tool.startsWith("mcp__") ? tool.slice(5).split("__") : [];
  const line = {
    timestamp: new Date().toISOString(),
    run_id: args.run || "",
    session_id: session,
    task_id: args.task || "",
    gsd_phase: args.phase || "",
    agent: sourceAgent,
    subagent: args.subagent || "",
    skill: args.skill || "",
    tool,
    mcp_server: args["mcp-server"] || tsParts[0] || "",
    mcp_tool: args["mcp-tool"] || tsParts.slice(1).join("__") || "",
    command: args.command || "",
    file: args.file || "",
    files_read: [] as string[],
    files_changed: [] as string[],
    graph_used: /graphify|graph-context-scan/.test(`${tool}${args.command ?? ""}`),
    context7_used: false,
    firecrawl_used: false,
    gitkraken_used: /gitkraken|gitlens/i.test(tool),
    github_mcp_used: /^mcp__github__/.test(tool),
    jules_used: /jules/i.test(`${tool}${args.command ?? ""}`),
    approval_id: args["approval-id"] || "",
    approval_required: args["approval-required"] === "true",
    approval_status: args["approval-status"] || "",
    result: args.result || "",
    error: args.error || "",
  };

  const json = JSON.stringify(line);
  if (args["dry-run"] === "true") {
    console.log("voidarch-context log-tool (DRY RUN — not written):");
    console.log(json);
    return;
  }

  const root = repoRootFromArgs(args);
  const slog = join(root, ".agent-runs", "sessions", session, "tools.jsonl");
  const aggregate = join(root, ".agent-runs", "current.jsonl");
  mkdirSync(dirname(slog), { recursive: true });
  appendFileSync(slog, `${json}\n`);
  appendFileSync(aggregate, `${json}\n`);
  console.log(`voidarch-context log-tool — appended ${tool} to ${slog}`);
}

main();
