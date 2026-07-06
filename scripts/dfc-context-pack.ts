// voidarch-context context - build a context pack for a task and print it to stdout. All
// diagnostics go to stderr so stdout stays clean (machine-readable JSON, or
// pasteable Markdown). Default output format is JSON here (voidarch-context context /
// dashboard compat); the `voidarch-context` bin defaults to --format markdown instead.
//   voidarch-context context --task "Add approval logging"
//   voidarch-context context --task "..." --format markdown --max-tokens 5000
//   voidarch-context context --task "..." --no-include-memory --no-include-graph

import { Table } from "surrealdb";
import { normalizeSourceAgent } from "../src/agents.js";
import { buildContextPack, formatContextPackMarkdown } from "../src/context-pack.js";
import { withDb } from "../src/surreal.js";
import { parseArgs, positiveIntArg, repoRootFromArgs, type CliArgs } from "../src/cli.js";

/** `--include-memory` (default on) / `--no-include-memory` (explicit off). */
function boolFlag(args: CliArgs, key: string): boolean {
  if (args[`no-${key}`] === "true") return false;
  if (args[key] === "false") return false;
  return true;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const task = (args.task || "").trim();
  const sourceAgent = normalizeSourceAgent(args.agent);
  const repoRoot = repoRootFromArgs(args);
  const format = (args.format || "json").toLowerCase();
  if (format !== "json" && format !== "markdown") {
    console.error(`--format must be "json" or "markdown" (got "${format}")`);
    process.exit(2);
  }
  const maxTokens = positiveIntArg(args, "max-tokens");
  const includeMemory = boolFlag(args, "include-memory");
  const includeGraph = boolFlag(args, "include-graph");
  if (!task) {
    console.error("--task is required");
    process.exit(2);
  }

  const pack = await withDb(async (db, cfg) => {
    const built = await buildContextPack(db, cfg.repoId, task, {
      repoRoot,
      maxTokens,
      includeMemory,
      includeGraph,
    });
    // Best-effort audit trail; never allowed to break the output contract.
    try {
      const now = new Date().toISOString();
      await db.create(new Table("task")).content({
        repo_id: cfg.repoId,
        source_agent: sourceAgent,
        goal: built.task.goal,
        phase: built.task.phase,
        created_at: now,
      });
      await db.create(new Table("context_pack")).content({
          repo_id: cfg.repoId,
          source_agent: sourceAgent,
          goal: built.task.goal,
          phase: built.task.phase,
          estimated_tokens: built.token_budget.estimated_tokens,
          pack: built,
          created_at: now,
      });
    } catch {
      /* persistence is optional for this slice */
    }
    return built;
  }, { repoRoot });

  if (format === "markdown") {
    process.stdout.write(formatContextPackMarkdown(pack));
  } else {
    process.stdout.write(`${JSON.stringify(pack)}\n`);
  }
}

try {
  await main();
  process.exit(0);
} catch (err) {
  console.error((err as Error)?.message ?? String(err));
  process.exit(1);
}
