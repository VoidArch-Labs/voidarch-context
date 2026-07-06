// voidarch-context graph import — import graphify-out/graph.json into SurrealDB graph memory.
//
//   voidarch-context graph import --dry-run        # parse + plan, write nothing (no creds)
//   voidarch-context graph import                  # replace repo graph rows; append snapshot
//   voidarch-context graph import --agent claude    # tag rows with a source agent
//   voidarch-context graph import --dry-run --json  # emit snapshot + counts as JSON
//
// graphify-out/ is gitignored and built locally with `/graphify` (or `graphify
// update .`). If it is absent or stale vs HEAD, this reports it instead of failing.

import { normalizeSourceAgent } from "../src/agents.js";
import { parseArgs, repoRootFromArgs } from "../src/cli.js";
import { buildGraphPlan, currentGitCommit, findGraphFile, importGraph, loadGraph } from "../src/graph.js";
import { loadConfig, withDb } from "../src/surreal.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sourceAgent = normalizeSourceAgent(args.agent);
  const dryRun = args["dry-run"] === "true";
  const asJson = args.json === "true";
  const root = repoRootFromArgs(args);

  const file = findGraphFile(root);
  if (!file) {
    console.error("voidarch-context graph import — no graphify-out/graph.json found.");
    console.error("  Build it first: run `/graphify` (Claude) or `graphify update .` (CLI).");
    process.exit(dryRun ? 0 : 1);
  }

  const repoId = loadConfig({ repoRoot: root }).repoId;
  const current = currentGitCommit(root);
  const plan = buildGraphPlan(loadGraph(file), repoId, sourceAgent, current, new Date().toISOString());

  if (asJson) {
    console.log(JSON.stringify({ snapshot: plan.snapshot }, null, 2));
    if (dryRun) return;
  }

  const s = plan.snapshot;
  console.log(`voidarch-context graph import ${dryRun ? "(DRY RUN — no writes)" : ""}`.trim());
  console.log(`  snapshot_id:     ${s.snapshot_id}`);
  console.log(`  built_at_commit: ${s.built_at_commit || "(unknown)"}`);
  console.log(`  fresh vs HEAD:   ${s.is_fresh}${s.is_fresh ? "" : ` (HEAD ${current.slice(0, 8)} — refresh with /graphify for current code)`}`);
  console.log(`  nodes:           ${s.node_count} (${Object.entries(s.kind_counts).map(([k, v]) => `${k}=${v}`).join(", ")})`);
  console.log(`  edges:           ${s.edge_count}`);
  console.log(`  hyperedges:      ${s.hyperedge_count}`);

  if (dryRun) return;

  const result = await withDb(async (db) => importGraph(db, plan), { repoRoot: root });
  console.log("  --- written to SurrealDB ---");
  console.log(`  graph_node:      ${result.nodes}`);
  console.log(`  graph_edge:      ${result.edges}`);
  console.log(`  graph_hyperedge: ${result.hyperedges}`);
  console.log(`  snapshot:        ${result.snapshotId} (replaced prior repo graph rows)`);
}

try {
  await main();
  process.exit(0);
} catch (err) {
  console.error((err as Error)?.message ?? String(err));
  process.exit(1);
}
